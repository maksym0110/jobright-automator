// Service worker: owns everything that needs the tabs API.
//  - Jobright tab = control tab. When "armed", any tab that appears is an
//    external company tab: record it and IMMEDIATELY refocus Jobright.
//  - Start/stop relay between popup and the content script.
//  - Resume-builder sync (runs here so the popup can close).
importScripts("shared.js");

let armed = false;
let jobrightTabId = null;
let newTabs = [];

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
        throw new Error(`Resume-builder sync failed - refusing to run on a possibly stale list (${err.message}). Fix Settings or start with "Run offline".`);
      }
      await log.warn(`Resume-builder sync failed, continuing with local history (${err.message})`);
    }
  } else if (opts.offline) {
    await log.warn("Run offline: skipping resume-builder sync");
  }

  await chrome.tabs.update(tab.id, { active: true });
  const res = await chrome.tabs.sendMessage(tab.id, { type: "start" }).catch(() => null);
  if (!res || !res.ok) throw new Error("Content script not responding - reload the Jobright tab and try again");
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

      // ---- from popup / options ----
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
