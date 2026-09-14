// Service worker: owns everything that needs the tabs / debugger API.
//  - Jobright tab = control tab. When "armed", any tab that appears is an
//    external company tab: record it and IMMEDIATELY refocus Jobright.
//  - Trusted clicks: a synthetic click can't pass Chrome's popup blocker, so
//    Apply is clicked through the DevTools protocol (like Playwright does).
//  - Start/stop relay between the panel and the content script.
//  - Resume-builder sync (runs here so the panel can close).
importScripts("shared.js");

let armed = false;
let jobrightTabId = null;
let newTabs = [];
let debuggerAttached = false;

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
async function trustedClick(tabId, x, y) {
  if (!(await attachDebugger(tabId))) return false;
  const target = { tabId };
  const base = { x, y, button: "left", clickCount: 1 };
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: "none" });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  return true;
}

/* ------------------------------------------------------------------ */
/* Run control                                                         */
/* ------------------------------------------------------------------ */

async function startRun(opts) {
  const tab = await findJobrightTab();
  if (!tab) throw new Error("No jobright.ai tab open");
  jobrightTabId = tab.id;
  const settings = await getSettings();
  await chrome.storage.local.set({ log: [] });

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
        return { ok: await trustedClick(sender.tab.id, msg.x, msg.y) };
      case "openTab": {
        // window.open was blocked in the page; open it from here instead.
        const t = await openExternalTab(msg.url);
        if (armed && !newTabs.some((n) => n.id === t.id)) newTabs.push({ id: t.id, url: msg.url });
        await focusJobright();
        return { ok: true };
      }
      case "runEnded":
        await detachDebugger(sender.tab.id);
        armed = false;
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
      default:
        return { ok: false, error: `unknown message ${msg.type}` };
    }
  })().then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the channel open for the async response
});
