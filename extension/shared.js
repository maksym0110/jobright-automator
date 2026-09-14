// Shared by background, content script, popup and options (classic script).
// Everything is stored in chrome.storage.local:
//   settings : the ".env" of the extension (see DEFAULT_SETTINGS)
//   history  : { [normalizedName]: { name, appliedAt, source } }
//   log      : last LOG_MAX lines
//   status   : { running, stats, current }  (written by the content script)

const DEFAULT_SETTINGS = {
  dryRun: true, // never click Apply; just report
  maxApplicationsPerRun: 2, // safety cap on Apply clicks per run
  maxScrollRounds: 3, // scroll attempts to load more jobs (0 = visible only)
  newTabTimeout: 15000, // ms to wait for the company tab
  confirmationTimeout: 20000, // ms to wait for "Did you apply?"
  onNewTabTimeout: "continue", // "continue" | "stop"
  applyNowBehavior: "skip", // "skip" | "click" for cards labelled "APPLY NOW"
  delayBetweenJobs: 2000, // ms pause between jobs

  // Resume-builder history via Supabase REST (PostgREST).
  supabaseUrl: "https://uzyeurtebuqmvshddrks.supabase.co",
  supabaseKey: "", // anon or service_role key (Supabase -> Settings -> API)
  remoteUserId: "", // optional: only this user's rows
  syncBeforeRun: true, // sync before every run
  requireSync: true, // refuse to run if the sync fails
};

const LOG_MAX = 400;

function normalizeCompanyName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function getHistory() {
  const { history } = await chrome.storage.local.get("history");
  return history || {};
}

async function hasApplied(companyName) {
  const history = await getHistory();
  return Object.prototype.hasOwnProperty.call(history, normalizeCompanyName(companyName));
}

/** Add names (deduplicated by normalized name). Returns how many were new. */
async function addToHistory(names, source) {
  const history = await getHistory();
  let added = 0;
  for (const raw of names) {
    const key = normalizeCompanyName(raw);
    if (!key || history[key]) continue;
    history[key] = { name: String(raw).trim(), appliedAt: new Date().toISOString(), source };
    added++;
  }
  if (added) await chrome.storage.local.set({ history });
  return added;
}

function timestamp() {
  return new Date().toTimeString().slice(0, 8);
}

/** Append a log line. level: "" | "WARN" | "ERROR" | "[DRY RUN]" */
async function appendLog(level, msg) {
  const line = `[${timestamp()}] ${level ? level + " " : ""}${msg}`;
  const { log } = await chrome.storage.local.get("log");
  const lines = log || [];
  lines.push(line);
  if (lines.length > LOG_MAX) lines.splice(0, lines.length - LOG_MAX);
  await chrome.storage.local.set({ log: lines });
  return line;
}

const log = {
  info: (m) => appendLog("", m),
  warn: (m) => appendLog("WARN", m),
  error: (m) => appendLog("ERROR", m),
  dry: (m) => appendLog("[DRY RUN]", m),
};

async function setStatus(patch) {
  const { status } = await chrome.storage.local.get("status");
  await chrome.storage.local.set({ status: { ...(status || {}), ...patch } });
}

async function getStatus() {
  const { status } = await chrome.storage.local.get("status");
  return status || { running: false };
}

/* ------------------------------------------------------------------ */
/* Resume-builder sync (Supabase REST). Read-only.                     */
/* ------------------------------------------------------------------ */

async function fetchCompanyNames(settings, table) {
  const base = settings.supabaseUrl.replace(/\/+$/, "");
  const headers = { apikey: settings.supabaseKey, Authorization: `Bearer ${settings.supabaseKey}` };
  const userFilter = settings.remoteUserId ? `&user_id=eq.${encodeURIComponent(settings.remoteUserId)}` : "";
  const names = [];
  const limit = 1000; // PostgREST default max rows per request
  for (let offset = 0; ; offset += limit) {
    const url = `${base}/rest/v1/${table}?select=company_name&company_name=not.is.null${userFilter}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const rows = await res.json();
    for (const r of rows) if (r.company_name && r.company_name.trim()) names.push(r.company_name);
    if (rows.length < limit) break;
  }
  return names;
}

/** Pull applications + interviews company names into the history. */
async function syncFromResumeBuilder(settings) {
  if (!settings.supabaseUrl || !settings.supabaseKey) throw new Error("Supabase URL / key not set (see Settings)");
  await log.info("Syncing applied companies from resume-builder DB...");
  const names = await fetchCompanyNames(settings, "applications");
  try {
    names.push(...(await fetchCompanyNames(settings, "interviews")));
  } catch (err) {
    await log.warn(`interviews table skipped: ${err.message}`);
  }
  const added = await addToHistory(names, "resume-builder");
  const total = Object.keys(await getHistory()).length;
  await log.info(`Remote sync: ${names.length} rows, ${added} new, history now has ${total}`);
  return { found: names.length, added, total };
}
