// Shared by background, content script, popup and options (classic script).
// Everything is stored in chrome.storage.local:
//   settings : the ".env" of the extension (see DEFAULT_SETTINGS)
//   history  : { [normalizedName]: { name, appliedAt, source } }
//   log      : last LOG_MAX lines
//   status   : { running, stats, current }  (written by the content script)
//   jobs     : rows for this batch — JD + generated documents (see the JOB shape below)
//   genState : progress of the resume / cover-letter generation queue
//   apiToken / apiUser : ai-resume-builder sign-in (the app generates the documents)

const DEFAULT_SETTINGS = {
  dryRun: true, // never click Apply; just report
  maxApplicationsPerRun: 2, // safety cap on Apply clicks per run
  minMatchScore: 70, // only process cards showing this match score or better (0 = all)
  maxScrollRounds: 3, // scroll attempts to load more jobs (0 = visible only)
  newTabTimeout: 15000, // ms to wait for the company tab
  confirmationTimeout: 20000, // ms to wait for "Did you apply?"
  onNewTabTimeout: "continue", // "continue" | "stop"
  applyNowBehavior: "skip", // "skip" | "click" for cards labelled "APPLY NOW"
  easyApplyBehavior: "click", // "click" | "skip" for cards labelled "EASY APPLY"
  delayBetweenJobs: 2000, // ms pause between jobs
  reloadBeforeRun: true, // reload the Jobright tab on Start so the job list is fresh
  confirmDelayMin: 1500, // ms to wait after "Did you apply?" appears before clicking Yes
  confirmDelayMax: 3500, // randomized between min and max so it doesn't look scripted

  // Resume-builder history via Supabase REST (PostgREST).
  supabaseUrl: "https://uzyeurtebuqmvshddrks.supabase.co",
  supabaseKey: "", // anon or service_role key (Supabase -> Settings -> API)
  remoteUserId: "", // optional: only this user's rows
  syncBeforeRun: true, // sync before every run
  requireSync: true, // refuse to run if the sync fails

  /* ---- JD capture on the company's own job site ---- */
  scrapeJd: true, // read the description from the tab Apply opens
  requireJd: true, // no description -> skip the job (and never mark it applied)
  jdTimeout: 30000, // ms to wait for the company page to render a description
  jdMinLength: 400, // anything shorter is not a real description
  skipEasyApply: true, // skip LinkedIn "Easy Apply" postings
  closeExternalTabs: true, // close the company tab once the JD is captured
  jobrightDetailFallback: true, // no company tab (EASY APPLY) -> read Jobright's own pane

  /* ---- Matched CV + cover letter (ai-resume-builder API) ---- */
  apiUrl: "https://ai-resume-builder-api-8aj2.onrender.com",
  generateDocuments: true, // generate a tailored resume + cover letter per job
  template: "classic", // style: classic | modern | minimal | executive | bold | compact
  downloadFolder: "Jobright-Automator", // inside the browser's Downloads folder
  apiDuplicateCheck: true, // also ask the app whether the company is a duplicate
  writeExcel: true, // write jobs.xlsx when the run finishes
};

const LOG_MAX = 400;
const JOBS_MAX = 300;

function normalizeCompanyName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Same presentation rule as the app's Generate page: fix ALL-CAPS / all-lowercase names. */
function prettyCompanyName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "";
  if (trimmed !== trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed.replace(/\S+/g, (word) =>
    word.length <= 4 && word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
  );
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

async function clearHistory() {
  await chrome.storage.local.set({ history: {} });
}

/**
 * The applied-company history belongs to one account. When a different person signs in,
 * keeping it would silently stop them applying to every company the previous account
 * had already used — so the history is stamped with its owner and dropped on a change.
 *
 * Returns the number of companies discarded.
 */
async function claimHistoryFor(email) {
  const owner = String(email || "").trim().toLowerCase();
  if (!owner) return 0;

  const { historyOwner } = await chrome.storage.local.get("historyOwner");
  if (historyOwner === owner) return 0;

  const previous = Object.keys(await getHistory()).length;
  await chrome.storage.local.set({ history: {}, historyOwner: owner });
  if (historyOwner && previous) {
    await log.warn(`Signed in as ${owner}; cleared ${previous} companies belonging to ${historyOwner}`);
  }
  return historyOwner ? previous : 0;
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
/* Job rows: one per posting whose description we captured.            */
/*                                                                     */
/* { no, jobId, company, title, salary, matchScore, posted, location, url, jd,      */
/*   jdVia, jdLength, collectedAt, outcome,                             */
/*   genStatus: "pending" | "generated" | "failed" | "off",             */
/*   genError, applicationId, genRole, generatedAt, files: {...} }       */
/* ------------------------------------------------------------------ */

async function getJobs() {
  const { jobs } = await chrome.storage.local.get("jobs");
  return Array.isArray(jobs) ? jobs : [];
}

async function saveJobs(jobs) {
  const trimmed = jobs.length > JOBS_MAX ? jobs.slice(jobs.length - JOBS_MAX) : jobs;
  await chrome.storage.local.set({ jobs: trimmed });
  return trimmed;
}

/**
 * Insert or merge a row, keyed by jobId (falling back to the JD link). New rows
 * get the batch's next number: it is the "No" column in the report and the prefix
 * of the job's document folder, so the two always line up.
 */
async function upsertJob(patch) {
  const jobs = await getJobs();
  const key = patch.jobId || patch.url;
  const index = jobs.findIndex((j) => (j.jobId || j.url) === key);
  if (index >= 0) {
    jobs[index] = { ...jobs[index], ...patch };
  } else {
    const no = jobs.reduce((max, j) => Math.max(max, Number(j.no) || 0), 0) + 1;
    jobs.push({ collectedAt: new Date().toISOString(), genStatus: "pending", ...patch, no });
  }
  await saveJobs(jobs);
  return index >= 0 ? jobs[index] : jobs[jobs.length - 1];
}

async function clearJobs() {
  await chrome.storage.local.set({ jobs: [], genState: null });
}

/* ------------------------------------------------------------------ */
/* ai-resume-builder API — the app generates the documents             */
/* ------------------------------------------------------------------ */

function apiRoot(settings) {
  return String(settings.apiUrl || DEFAULT_SETTINGS.apiUrl)
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");
}

async function getApiToken() {
  const { apiToken } = await chrome.storage.local.get("apiToken");
  return apiToken || "";
}

async function getApiUser() {
  const { apiUser } = await chrome.storage.local.get("apiUser");
  return apiUser || null;
}

/**
 * Call the app's API with the stored token, surfacing the API's own error text so
 * the log says what is wrong (a 401 means "sign in again", not "broken").
 */
async function apiFetch(path, { method = "GET", body, settings, token } = {}) {
  const config = settings || (await getSettings());
  const bearer = token !== undefined ? token : await getApiToken();
  if (!bearer) throw new Error("Not signed in to the resume builder (Settings -> Resume builder)");

  const res = await fetch(`${apiRoot(config)}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Resume-builder session expired - sign in again in Settings");
  if (!res.ok) throw new Error(data.error || `${path} failed (HTTP ${res.status})`);
  return data;
}

/** Sign in once and keep the token; the panel and the generator both use it. */
async function apiLogin(email, password, settingsPatch) {
  const settings = { ...(await getSettings()), ...(settingsPatch || {}) };
  const res = await fetch(`${apiRoot(settings)}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error(data.error || `Sign-in failed (HTTP ${res.status})`);
  await chrome.storage.local.set({ apiToken: data.token, apiUser: data.user || { email } });
  return data.user || { email };
}

async function apiLogout() {
  await chrome.storage.local.remove(["apiToken", "apiUser"]);
}

/** Applied to this company in the last 30 days? The same rule as the Generate page. */
async function apiIsDuplicateCompany(company, settings) {
  const name = prettyCompanyName(company);
  if (!name) return false;
  const data = await apiFetch(`/api/applications/check-duplicate?companyName=${encodeURIComponent(name)}`, { settings });
  return Boolean(data.isDuplicate);
}

async function apiGenerateDocuments({ jd, jdLink, company, title, template }, settings) {
  return apiFetch("/api/cv/generate", {
    method: "POST",
    settings,
    body: {
      jobDescription: jd,
      jdLink: jdLink || "",
      companyName: prettyCompanyName(company),
      jobTitle: title || "",
      template: template || "classic",
      force: true, // duplicates are filtered long before we get here
    },
  });
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

/**
 * Pull the signed-in account's applied companies into the history.
 *
 * The app's own endpoint is used whenever we are signed in, because it answers for
 * *that user* only. The Supabase route is the fallback for an unauthenticated setup,
 * and it reads the table directly: without `remoteUserId` it returns every user's
 * companies, which would stop a new account applying anywhere the previous one had.
 */
async function syncFromResumeBuilder(settings) {
  const token = await getApiToken();

  if (token) {
    const user = (await getApiUser()) || {};
    const discarded = await claimHistoryFor(user.email);
    await log.info(`Syncing applied companies for ${user.email || "this account"}...`);

    const data = await apiFetch("/api/applications/companies", { settings });
    const names = (data.companies || []).map((c) => c.companyName).filter(Boolean);
    const added = await addToHistory(names, "resume-builder");
    const total = Object.keys(await getHistory()).length;
    await log.info(`Sync: ${names.length} of your companies, ${added} new, history now has ${total}${discarded ? ` (${discarded} from the previous account were dropped)` : ""}`);
    return { found: names.length, added, total, scopedToUser: true };
  }

  if (!settings.supabaseUrl || !settings.supabaseKey) {
    throw new Error("Sign in to the resume builder under Settings (or set a Supabase URL / key)");
  }
  if (!settings.remoteUserId) {
    await log.warn("Supabase sync without a user id reads EVERY account's companies - sign in instead, or set your user id in Settings");
  }
  await log.info("Syncing applied companies from the resume-builder database...");
  const names = await fetchCompanyNames(settings, "applications");
  try {
    names.push(...(await fetchCompanyNames(settings, "interviews")));
  } catch (err) {
    await log.warn(`interviews table skipped: ${err.message}`);
  }
  const added = await addToHistory(names, "resume-builder");
  const total = Object.keys(await getHistory()).length;
  await log.info(`Remote sync: ${names.length} rows, ${added} new, history now has ${total}`);
  return { found: names.length, added, total, scopedToUser: Boolean(settings.remoteUserId) };
}
