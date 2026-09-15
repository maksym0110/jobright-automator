const $ = (id) => document.getElementById(id);

const NUMBER_FIELDS = ["maxApplicationsPerRun", "maxScrollRounds", "delayBetweenJobs", "newTabTimeout", "confirmationTimeout", "confirmDelayMin", "confirmDelayMax"];
const TEXT_FIELDS = ["applyNowBehavior", "onNewTabTimeout", "supabaseUrl", "supabaseKey", "remoteUserId"];
const BOOL_FIELDS = ["dryRun", "syncBeforeRun", "requireSync", "reloadBeforeRun"];

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

$("exportHistory").addEventListener("click", async () => {
  const history = await getHistory();
  const blob = new Blob([JSON.stringify(Object.values(history), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "jobright-history.json";
  a.click();
});

getSettings().then(fillForm);
refreshHistoryCount();
