// Service worker: owns everything that needs the tabs / scripting / downloads APIs.
//  - Jobright tab = control tab. When "armed", any tab that appears is an
//    external company tab: record it and IMMEDIATELY refocus Jobright.
//  - The job description lives on the company's own page, so it is scraped here
//    (jd-scraper.js, injected into every frame of that tab) and the tab is closed.
//  - Trusted clicks: a synthetic click can't pass Chrome's popup blocker, so
//    Apply is clicked through the DevTools protocol (like Playwright does).
//  - Start/stop relay between the panel and the content script.
//  - Resume-builder sync and the CV/cover-letter queue (generator.js) run here so
//    they survive the panel being closed.
importScripts("shared.js", "xlsx-writer.js", "generator.js");

let armed = false;
let jobrightTabId = null;
let newTabs = [];
let debuggerAttached = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Side panel (stays open while tabs change, unlike a popup)           */
/* ------------------------------------------------------------------ */

if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else {
  // Older Chromium without a side panel: open the panel as its own window.
  chrome.action.onClicked.addListener(() => {
    chrome.windows.create({ url: "popup.html", type: "popup", width: 460, height: 640 });
  });
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!armed || tab.id === jobrightTabId) return;
  newTabs.push({ id: tab.id, url: tab.pendingUrl || tab.url || "" });
  await focusJobright();
});

// Keep the recorded URL current: the tab usually starts blank and then redirects
// through the ATS, and that final URL is the one worth keeping as the JD link.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  const known = newTabs.find((t) => t.id === tabId);
  if (known) known.url = info.url;
});

async function focusJobright() {
  if (jobrightTabId === null) return;
  try {
    const tab = await chrome.tabs.update(jobrightTabId, { active: true });
    if (tab) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (err) {
    await log.warn(`Could not refocus Jobright tab: ${err.message}`);
  }
}

async function findJobrightTab() {
  const tabs = await chrome.tabs.query({ url: "https://jobright.ai/*" });
  const active = tabs.find((t) => t.active) || tabs[0];
  return active || null;
}

/** Open the external tab ourselves (fallback when window.open was blocked). */
async function openExternalTab(url) {
  const opener = jobrightTabId !== null ? await chrome.tabs.get(jobrightTabId).catch(() => null) : null;
  const tab = await chrome.tabs.create({
    url,
    active: false, // never steal focus from Jobright
    windowId: opener ? opener.windowId : undefined,
    index: opener ? opener.index + 1 + newTabs.length : undefined,
  });
  return tab;
}

async function closeTab(tabId) {
  await chrome.tabs.remove(tabId).catch(() => {});
  newTabs = newTabs.filter((t) => t.id !== tabId);
}

/* ------------------------------------------------------------------ */
/* Job description, read from the company's own job page               */
/* ------------------------------------------------------------------ */

/** Company pages redirect and hydrate, so "complete" is a floor, not a guarantee. */
async function waitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("the company tab was closed before the description could be read");
    if (tab.status === "complete") return tab;
    await sleep(300);
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

/**
 * Inject the scraper into every frame and keep the longest description found —
 * Greenhouse, Lever and friends render the posting inside an iframe. Retries
 * until the page has something worth reading, or the timeout expires.
 */
async function scrapeJdFromTab(tabId, settings) {
  const timeout = Math.max(5000, Number(settings.jdTimeout) || 30000);
  const minLength = Math.max(120, Number(settings.jdMinLength) || 400);
  const deadline = Date.now() + timeout;

  await waitForTabComplete(tabId, Math.min(timeout, 20000));

  let best = null;
  let reason = "";
  let easyApply = false;

  while (Date.now() < deadline) {
    let results = [];
    try {
      results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["jd-scraper.js"] });
    } catch (err) {
      reason = err.message.replace(/^Error:\s*/, "");
      // Nothing can be injected here (a PDF viewer, a chrome:// page, a closed
      // tab): retrying will not change that.
      if (/cannot be scripted|No tab with id|Frame with id|not be injected/i.test(reason)) break;
    }

    for (const frame of results) {
      const found = frame && frame.result;
      if (!found) continue;
      if (found.easyApply) easyApply = true;
      if (found.ok) {
        if (!best || found.length > best.length) best = found;
      } else if (!reason) {
        reason = found.reason;
      }
    }

    if (best && best.length >= minLength) {
      // The link we keep is the page the user would open — not the ATS iframe the
      // text happened to come from.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      return { ok: true, ...best, easyApply, url: (tab && tab.url) || best.url || "", frameUrl: best.url || "" };
    }
    await sleep(1200);
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return { ok: false, reason: reason || "no job description found", easyApply, url: (tab && tab.url) || "" };
}

const LINKEDIN_JOB_RE = /linkedin\.com\/(?:jobs|job)\//i;

/**
 * Read the JD from the company tab, then close it — the JD link is kept in the
 * report, so twenty open tabs buy nothing. "Easy Apply" postings are rejected
 * here, before anything gets marked as applied.
 */
async function captureJd(tabId, settings) {
  const result = await scrapeJdFromTab(tabId, settings).catch((err) => ({ ok: false, reason: err.message }));

  if (result.ok && settings.skipEasyApply && result.easyApply && LINKEDIN_JOB_RE.test(result.url || "")) {
    if (settings.closeExternalTabs) await closeTab(tabId);
    return { ok: false, reason: "LinkedIn Easy Apply", easyApply: true, url: result.url };
  }
  if (settings.closeExternalTabs) await closeTab(tabId);
  return result;
}

/* ------------------------------------------------------------------ */
/* Trusted click through the DevTools protocol                         */
/* ------------------------------------------------------------------ */

async function attachDebugger(tabId) {
  if (debuggerAttached) return true;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    debuggerAttached = true;
    return true;
  } catch (err) {
    await log.warn(`Could not attach debugger (${err.message}) - falling back to synthetic clicks. Close DevTools on the Jobright tab if it is open.`);
    return false;
  }
}

async function detachDebugger(tabId) {
  if (!debuggerAttached) return;
  debuggerAttached = false;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === jobrightTabId) debuggerAttached = false;
});

/** Real mouse click at viewport coordinates (CSS px). */
// Input.dispatchMouseEvent modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
const MODIFIER = { ctrl: 2, meta: 4 };
let platformCache = null;

/** Ctrl on Windows and Linux, Command on a Mac — the "open in a new tab" modifier. */
async function newTabModifier() {
  if (!platformCache) platformCache = await chrome.runtime.getPlatformInfo().catch(() => ({ os: "win" }));
  return platformCache.os === "mac" ? MODIFIER.meta : MODIFIER.ctrl;
}

/**
 * Real mouse click at viewport coordinates (CSS px).
 *
 * With `newTab`, the click carries the Ctrl (or Command) modifier, which is how a
 * person opens a link in a background tab: the page keeps focus, and the job opens
 * beside it instead of navigating the control tab away.
 */
async function trustedClick(tabId, x, y, { newTab = false } = {}) {
  if (!(await attachDebugger(tabId))) return false;
  const target = { tabId };
  const modifiers = newTab ? await newTabModifier() : 0;
  const base = { x, y, button: "left", clickCount: 1, modifiers };
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: "none" });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  return true;
}

/* ------------------------------------------------------------------ */
/* Run control                                                         */
/* ------------------------------------------------------------------ */

/** Reload the tab and wait until the page (and our content script) is back. */
async function reloadAndWait(tabId, timeoutMs = 30000) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); reject(new Error("Jobright tab did not finish reloading")); }, timeoutMs);
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.reload(tabId).catch(reject);
  });
  // The SPA renders the list after "complete"; poll until the content script answers.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await chrome.tabs.sendMessage(tabId, { type: "ping" }).catch(() => null);
    if (res && res.ok) {
      await new Promise((r) => setTimeout(r, 2500)); // let the job cards render
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Content script did not come back after reload");
}

/** Fail before the browser starts clicking, not after twenty JDs are captured. */
async function assertCanGenerate(settings) {
  if (!settings.generateDocuments) return;
  if (!(await getApiToken())) {
    throw new Error('Not signed in to the resume builder - sign in under Settings, or turn off "Generate CV + cover letter"');
  }
  let me;
  try {
    me = await apiFetch("/api/auth/me", { settings });
  } catch (err) {
    throw new Error(`Resume builder unreachable (${err.message})`);
  }
  const email = (me && me.user && me.user.email) || (await getApiUser() || {}).email || "";
  await log.info(`Resume builder ready${email ? ` as ${email}` : ""} - document style: ${settings.template}`);
}

async function startRun(opts) {
  const tab = await findJobrightTab();
  if (!tab) throw new Error("No jobright.ai tab open");
  jobrightTabId = tab.id;
  const settings = await getSettings();
  await chrome.storage.local.set({ log: [] });

  if (!settings.dryRun) await assertCanGenerate(settings);

  // A run is one batch: its own download folder and its own Excel report.
  await chrome.storage.local.set({
    jobs: [],
    genState: { folder: batchFolder(settings), collecting: true, status: "idle", total: 0, done: 0 },
  });

  if (settings.reloadBeforeRun) {
    await log.info("Reloading Jobright for a fresh job list...");
    await chrome.tabs.update(tab.id, { active: true });
    await reloadAndWait(tab.id);
  }

  if (settings.syncBeforeRun && !opts.offline) {
    try {
      await syncFromResumeBuilder(settings);
    } catch (err) {
      if (settings.requireSync) {
        throw new Error(`Resume-builder sync failed - refusing to run on a possibly stale list (${err.message}). Fix Settings or start with "Start offline".`);
      }
      await log.warn(`Resume-builder sync failed, continuing with local history (${err.message})`);
    }
  } else if (opts.offline) {
    await log.warn("Start offline: skipping resume-builder sync");
  }

  await chrome.tabs.update(tab.id, { active: true });
  if (!settings.dryRun) await attachDebugger(tab.id);
  const res = await chrome.tabs.sendMessage(tab.id, { type: "start" }).catch(() => null);
  if (!res || !res.ok) {
    await detachDebugger(tab.id);
    throw new Error("Content script not responding - reload the Jobright tab and try again");
  }
}

async function stopRun() {
  const tab = await findJobrightTab();
  if (tab) await chrome.tabs.sendMessage(tab.id, { type: "stop" }).catch(() => {});
}

/** Duplicate by company name: the local history first, then the app's own rule. */
async function isDuplicateCompany(company, settings) {
  if (await hasApplied(company)) return { duplicate: true, via: "history" };
  if (!settings.apiDuplicateCheck || !(await getApiToken())) return { duplicate: false };
  try {
    return { duplicate: await apiIsDuplicateCompany(company, settings), via: "app" };
  } catch (err) {
    await log.warn(`Duplicate check skipped for ${company}: ${err.message}`);
    return { duplicate: false };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      // ---- from the content script ----
      case "arm":
        jobrightTabId = sender.tab.id;
        armed = true;
        newTabs = [];
        return { ok: true };
      case "check":
        return { newTabs };
      case "disarm":
        armed = false;
        return { ok: true };
      case "focusJobright":
        jobrightTabId = sender.tab ? sender.tab.id : jobrightTabId;
        await focusJobright();
        return { ok: true };
      case "trustedClick":
        return { ok: await trustedClick(sender.tab.id, msg.x, msg.y, { newTab: Boolean(msg.newTab) }) };
      case "openTab": {
        // window.open was blocked in the page; open it from here instead.
        const t = await openExternalTab(msg.url);
        if (armed && !newTabs.some((n) => n.id === t.id)) newTabs.push({ id: t.id, url: msg.url });
        await focusJobright();
        return { ok: true };
      }
      case "scrapeJd": {
        const settings = await getSettings();
        const result = await captureJd(msg.tabId, settings);
        await focusJobright();
        return { ok: true, result };
      }
      case "closeExternalTab":
        await closeTab(msg.tabId);
        return { ok: true };
      case "checkDuplicate":
        return { ok: true, ...(await isDuplicateCompany(msg.company, await getSettings())) };
      case "queueJob": {
        // A captured JD: store the row, then let the generator work on it while
        // the bot carries on through the feed.
        const row = await upsertJob(msg.job);
        await kickGenerator({ collecting: true });
        return { ok: true, total: (await getJobs()).length, row };
      }
      case "updateJob":
        await upsertJob(msg.job);
        return { ok: true };
      case "runEnded":
        await detachDebugger(sender.tab.id);
        armed = false;
        // No more rows are coming: drain the queue and write the report.
        await kickGenerator({ collecting: false, force: true });
        return { ok: true };

      // ---- from panel / options ----
      case "start":
        await startRun({ offline: !!msg.offline });
        return { ok: true };
      case "stop":
        await stopRun();
        return { ok: true };
      case "sync":
        return { ok: true, ...(await syncFromResumeBuilder(await getSettings())) };
      case "testConnection": {
        const settings = { ...(await getSettings()), ...(msg.settings || {}) };
        const names = await fetchCompanyNames(settings, "applications");
        return { ok: true, count: names.length, sample: names.slice(0, 5) };
      }
      case "apiLogin": {
        const user = await apiLogin(msg.email, msg.password, msg.settings);
        const dropped = await claimHistoryFor(user.email);
        await log.info(`Signed in to the resume builder as ${user.email}`);
        return { ok: true, user, historyCleared: dropped };
      }
      case "apiLogout":
        await apiLogout();
        return { ok: true };
      case "clearHistory": {
        const had = Object.keys(await getHistory()).length;
        await clearHistory();
        await log.info(`Applied-company history cleared (${had} companies)`);
        return { ok: true, cleared: had };
      }
      case "apiStatus": {
        const settings = { ...(await getSettings()), ...(msg.settings || {}) };
        if (!(await getApiToken())) return { ok: true, signedIn: false };
        try {
          const me = await apiFetch("/api/auth/me", { settings });
          return { ok: true, signedIn: true, user: me.user || (await getApiUser()) };
        } catch (err) {
          return { ok: true, signedIn: false, error: err.message };
        }
      }
      case "generateNow": // generate rows collected earlier / finish a batch
        await kickGenerator({ collecting: false, force: true });
        return { ok: true };
      case "retryFailed": {
        const jobs = await getJobs();
        await saveJobs(jobs.map((j) => (j.genStatus === "failed" ? { ...j, genStatus: "pending", genError: "" } : j)));
        await kickGenerator({ collecting: false, force: true });
        return { ok: true };
      }
      case "stopGenerator":
        await setGenState({ cancel: true, status: "stopping", note: "finishing the current job..." });
        return { ok: true };
      case "writeExcelNow": {
        const state = await getGenState();
        const settings = await getSettings();
        const jobs = await getJobs();
        if (!jobs.length) return { ok: false, error: "No jobs in this batch yet" };
        const file = await writeExcel(jobs, state.folder || batchFolder(settings));
        await log.info(`Excel report saved: ${file}`);
        return { ok: true, file };
      }
      case "clearJobs":
        await clearJobs();
        return { ok: true };
      default:
        return { ok: false, error: `unknown message ${msg.type}` };
    }
  })().then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the channel open for the async response
});
