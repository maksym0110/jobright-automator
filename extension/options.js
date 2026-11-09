const $ = (id) => document.getElementById(id);

const NUMBER_FIELDS = ["maxApplicationsPerRun", "minMatchScore", "maxScrollRounds", "delayBetweenJobs", "newTabTimeout", "confirmationTimeout", "confirmDelayMin", "confirmDelayMax", "jdTimeout", "jdMinLength"];
const TEXT_FIELDS = ["applyNowBehavior", "easyApplyBehavior", "onNewTabTimeout", "supabaseUrl", "supabaseKey", "remoteUserId", "apiUrl", "template", "downloadFolder"];
const BOOL_FIELDS = ["dryRun", "syncBeforeRun", "requireSync", "reloadBeforeRun", "scrapeJd", "requireJd", "skipEasyApply", "closeExternalTabs", "jobrightDetailFallback", "generateDocuments", "writeExcel", "apiDuplicateCheck"];

function readForm() {
  const s = {};
  for (const k of NUMBER_FIELDS) s[k] = Math.max(0, parseInt($(k).value, 10) || 0);
  for (const k of TEXT_FIELDS) s[k] = $(k).value.trim();
  for (const k of BOOL_FIELDS) s[k] = $(k).checked;
  return s;
}

function fillForm(s) {
  for (const k of NUMBER_FIELDS) $(k).value = s[k];
  for (const k of TEXT_FIELDS) $(k).value = s[k];
  for (const k of BOOL_FIELDS) $(k).checked = !!s[k];
}

function flash(id, textContent, ok = true) {
  const el = $(id);
  el.textContent = textContent;
  el.className = ok ? "ok" : "err";
}

async function refreshHistoryCount() {
  $("historyCount").textContent = String(Object.keys(await getHistory()).length);
  const { historyOwner } = await chrome.storage.local.get("historyOwner");
  $("historyOwner").textContent = historyOwner || "nobody yet — it is claimed on the next sign-in";
}

$("save").addEventListener("click", async () => {
  await saveSettings(readForm());
  flash("msg", "Saved.");
});

$("reset").addEventListener("click", async () => {
  if (!confirm("Reset all settings to defaults? (History is kept.)")) return;
  await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  fillForm(DEFAULT_SETTINGS);
  flash("msg", "Defaults restored.");
});

/* ------------------------------------------------------------------ */
/* Resume-builder sign-in (the app generates the documents)            */
/* ------------------------------------------------------------------ */

async function refreshApiStatus() {
  const res = await chrome.runtime.sendMessage({ type: "apiStatus", settings: { apiUrl: $("apiUrl").value.trim() } }).catch(() => null);
  const el = $("apiStatus");
  if (res && res.signedIn) {
    el.textContent = (res.user && res.user.email) || "signed in";
    el.className = "ok";
  } else {
    el.textContent = res && res.error ? `not signed in — ${res.error}` : "not signed in";
    el.className = "err";
  }
}

$("apiSignIn").addEventListener("click", async () => {
  const email = $("apiEmail").value.trim();
  const password = $("apiPassword").value;
  if (!email || !password) return flash("apiMsg", "Enter your resume-builder email and password.", false);
  await saveSettings(readForm());
  flash("apiMsg", "Signing in...");
  const res = await chrome.runtime.sendMessage({ type: "apiLogin", email, password, settings: { apiUrl: $("apiUrl").value.trim() } }).catch((e) => ({ ok: false, error: e.message }));
  if (res && res.ok) {
    $("apiPassword").value = "";
    flash("apiMsg", `Signed in as ${res.user.email}`);
  } else {
    flash("apiMsg", `Failed: ${(res && res.error) || "no response"}`, false);
  }
  refreshApiStatus();
});

$("apiSignOut").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "apiLogout" }).catch(() => {});
  flash("apiMsg", "Signed out.");
  refreshApiStatus();
});

$("test").addEventListener("click", async () => {
  flash("syncMsg", "Testing...");
  const res = await chrome.runtime.sendMessage({ type: "testConnection", settings: readForm() });
  if (res && res.ok) flash("syncMsg", `OK — ${res.count} rows in applications (e.g. ${res.sample.join(", ")})`);
  else flash("syncMsg", `Failed: ${(res && res.error) || "no response"}`, false);
});

$("sync").addEventListener("click", async () => {
  await saveSettings(readForm());
  flash("syncMsg", "Syncing...");
  const res = await chrome.runtime.sendMessage({ type: "sync" });
  if (res && res.ok) flash("syncMsg", `Synced: ${res.found} rows, ${res.added} new, history now ${res.total}`);
  else flash("syncMsg", `Failed: ${(res && res.error) || "no response"}`, false);
  refreshHistoryCount();
});

$("addManual").addEventListener("click", async () => {
  const names = $("manual").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const added = await addToHistory(names, "bot");
  flash("histMsg", `${added} added (${names.length - added} already present).`);
  $("manual").value = "";
  refreshHistoryCount();
});

$("clearHistory").addEventListener("click", async () => {
  const count = Object.keys(await getHistory()).length;
  if (count && !confirm(`Forget ${count} applied companies? The bot will be free to apply to all of them again.`)) return;
  const res = await chrome.runtime.sendMessage({ type: "clearHistory" }).catch((e) => ({ ok: false, error: e.message }));
  flash("histMsg", res && res.ok ? `Cleared ${res.cleared} companies.` : `Failed: ${(res && res.error) || "no response"}`, Boolean(res && res.ok));
  refreshHistoryCount();
});

$("exportHistory").addEventListener("click", async () => {
  const history = await getHistory();
  const blob = new Blob([JSON.stringify(Object.values(history), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "jobright-history.json";
  a.click();
});

getSettings().then(fillForm).then(refreshApiStatus);
refreshHistoryCount();
