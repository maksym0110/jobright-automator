/**
 * Matched CV + cover letter generation, and the Excel report.
 *
 * Runs in the service worker so it keeps going while the panel is closed and
 * while the bot is still working through the Jobright feed: the content script
 * queues a row per captured JD, this drains the queue in the background. An
 * alarm keeps the worker alive and restarts the loop if Chrome recycles it.
 *
 * Loaded by background.js via importScripts (after shared.js and xlsx-writer.js).
 */

const GEN_ALARM = "generator-keepalive";
let generating = false;

function safeFileName(name) {
  return (
    String(name || "file")
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 60) || "file"
  );
}

function batchFolder(settings) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `${safeFileName(settings.downloadFolder || "Jobright-Automator")}/batch-${stamp}`;
}

async function getGenState() {
  const { genState } = await chrome.storage.local.get("genState");
  return genState || {};
}

async function setGenState(patch) {
  const next = { ...(await getGenState()), ...patch, at: Date.now() };
  await chrome.storage.local.set({ genState: next });
  return next;
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

function toDataUrl(bytes, mime) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Resolve once the download is finished, so the recorded path is the final one. */
function waitForDownload(id, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (!item) return resolve({ error: "download vanished" });
      if (item.state === "complete") return resolve({ filename: item.filename });
      if (item.state === "interrupted") return resolve({ error: item.error || "interrupted" });
      if (Date.now() - started > timeoutMs) return resolve({ filename: item.filename, error: "timeout" });
      setTimeout(poll, 250);
    };
    poll();
  });
}

/**
 * The API only serves generated files to an authenticated request, so fetch them
 * here and hand chrome.downloads a data: URL — a service worker cannot create
 * blob: URLs.
 */
async function downloadAuthed(url, token, filename) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const id = await chrome.downloads.download({
    url: toDataUrl(bytes, res.headers.get("content-type") || "application/octet-stream"),
    filename,
    saveAs: false,
    // A job's folder should hold exactly four current files, so a retry replaces
    // them rather than adding "Name (1).pdf" next to the old attempt.
    conflictAction: "overwrite",
  });
  const done = await waitForDownload(id);
  if (done.error && !done.filename) throw new Error(done.error);
  return done.filename || filename;
}

/* ------------------------------------------------------------------ */
/* Excel report                                                        */
/* ------------------------------------------------------------------ */

// The number is also the job's folder prefix, so a row points straight at its
// documents; everything else about a row is in the panel and the log.
const COLUMNS = [
  { header: "No", key: "no", width: 6 },
  { header: "Company Name", key: "company", width: 30 },
  { header: "Role", key: "role", width: 38 },
  { header: "JD link", key: "link", width: 60 },
];

async function writeExcel(jobs, folder) {
  const rows = jobs.map((job, index) => ({
    no: Number(job.no) || index + 1,
    company: job.company || "",
    role: job.genRole || job.title || "",
    link: job.url ? { text: job.url, link: job.url } : "",
  }));

  const bytes = self.XlsxWriter.buildXlsx({ sheetName: "Jobs", columns: COLUMNS, rows });
  const id = await chrome.downloads.download({
    url: toDataUrl(bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    filename: `${folder}/jobs.xlsx`,
    saveAs: false,
    // One report per batch: a re-run or a retry replaces it instead of leaving
    // "jobs (1).xlsx" behind for the reader to date-check.
    conflictAction: "overwrite",
  });
  const done = await waitForDownload(id);
  if (done.error && !done.filename) throw new Error(`could not save the Excel file: ${done.error}`);
  return done.filename || `${folder}/jobs.xlsx`;
}

/* ------------------------------------------------------------------ */
/* One job                                                             */
/* ------------------------------------------------------------------ */

/**
 * Documents are named after you, not after the job — that is the name a recruiter
 * sees when the file lands in their inbox. The folder carries the job identity.
 */
let cachedDocumentName = "";

async function documentName(settings) {
  if (cachedDocumentName) return cachedDocumentName;
  const stored = (await getApiUser()) || {};
  let fullName = stored.full_name || "";
  if (!fullName) {
    try {
      const me = await apiFetch("/api/auth/me", { settings });
      if (me && me.user) {
        fullName = me.user.full_name || "";
        await chrome.storage.local.set({ apiUser: { ...stored, ...me.user } });
      }
    } catch {
      // Not fatal: fall back to the account's email name.
    }
  }
  cachedDocumentName = safeFileName(fullName || String(stored.email || "").split("@")[0] || "resume");
  return cachedDocumentName;
}

async function generateOne(config, job, settings, folder, token) {
  const company = prettyCompanyName(job.company);
  const data = await apiGenerateDocuments(
    { jd: job.jd, jdLink: job.url, company, title: job.title, template: settings.template },
    settings,
  );
  const application = data.application || {};
  const files = {};
  const problems = [];

  if (application.id) {
    const root = apiRoot(settings);
    // One folder per company: "3_Northwind_Labs", matching the report's No column.
    const jobFolder = `${folder}/${job.no || ""}_${safeFileName(application.companyName || company)}`;
    const name = await documentName(settings);
    const targets = [
      ["resumePdf", `${root}/api/cv/download/pdf/${application.id}`, `${jobFolder}/${name}.pdf`],
      ["resumeDocx", `${root}/api/cv/download/docx/${application.id}`, `${jobFolder}/${name}.docx`],
      ["coverPdf", `${root}/api/cv/download/cover-letter/pdf/${application.id}`, `${jobFolder}/${name}_cover.pdf`],
      ["coverDocx", `${root}/api/cv/download/cover-letter/docx/${application.id}`, `${jobFolder}/${name}_cover.docx`],
    ];
    for (const [key, url, filename] of targets) {
      try {
        files[key] = await downloadAuthed(url, token, filename);
      } catch (err) {
        // A missing cover letter is a warning; a missing resume is the point of the run.
        problems.push(`${key}: ${err.message}`);
      }
    }
  }

  return {
    genStatus: "generated",
    genError: problems.length ? problems.join("; ") : "",
    folder: application.id ? `${folder}/${job.no || ""}_${safeFileName(application.companyName || company)}` : "",
    applicationId: application.id || null,
    genRole: application.jobTitle || job.title || "",
    company: application.companyName || company,
    template: settings.template,
    generatedAt: new Date().toISOString(),
    files,
  };
}

/* ------------------------------------------------------------------ */
/* Queue loop                                                          */
/* ------------------------------------------------------------------ */

/**
 * Drain every pending row, then write the Excel report if the Jobright run has
 * finished (otherwise the next queued job restarts the loop and the report is
 * written once, at the end).
 */
async function runGenerator() {
  if (generating) return;
  generating = true;
  chrome.alarms.create(GEN_ALARM, { periodInMinutes: 0.4 });

  try {
    const settings = await getSettings();
    const token = await getApiToken();

    // Only complain about the sign-in when there is something to generate: a dry
    // run finishes here too, and it has nothing to ask the API for.
    if (!token && (await getJobs()).some((j) => j.genStatus === "pending" && j.jd)) {
      await setGenState({ status: "error", note: "Not signed in to the resume builder (Settings)" });
      await log.error("Documents not generated: sign in to the resume builder in Settings");
      return;
    }

    let state = await getGenState();
    const folder = state.folder || (await setGenState({ folder: batchFolder(settings) })).folder;

    for (;;) {
      state = await getGenState();
      if (state.cancel) {
        await setGenState({ status: "stopped", note: "stopped by you" });
        return;
      }

      const jobs = await getJobs();
      const index = jobs.findIndex((j) => j.genStatus === "pending" && j.jd);
      const done = jobs.filter((j) => j.genStatus && j.genStatus !== "pending").length;

      if (index < 0) {
        const finished = jobs.filter((j) => j.genStatus === "generated").length;
        const failed = jobs.filter((j) => j.genStatus === "failed").length;
        // The bot may still be walking the feed; leave the report for the end.
        if (state.collecting) {
          await setGenState({ status: "waiting", note: "waiting for the next job", done, total: jobs.length, generated: finished, failed });
          return;
        }
        const file = settings.writeExcel && jobs.length ? await writeExcel(jobs, folder) : "";
        await setGenState({
          status: "done",
          note: file ? `Saved ${file}` : "nothing to generate",
          file,
          done,
          total: jobs.length,
          generated: finished,
          failed,
        });
        if (file) await log.info(`Excel report saved: ${file}`);
        return;
      }

      const job = jobs[index];
      await setGenState({ status: "running", total: jobs.length, done, note: `${job.company || "job"} — ${job.title || ""}` });
      await log.info(`Generating CV + cover letter for ${job.company}${job.title ? ` (${job.title})` : ""}...`);

      let patch;
      try {
        patch = await generateOne(null, job, settings, folder, token);
        await log.info(
          patch.genError
            ? `Documents for ${patch.company} generated with warnings: ${patch.genError}`
            : `Documents ready in ${patch.folder ? patch.folder.split("/").pop() : "the batch folder"} (application #${patch.applicationId})`,
        );
      } catch (err) {
        patch = { genStatus: "failed", genError: err.message, template: settings.template };
        await log.error(`Could not generate documents for ${job.company}: ${err.message}`);
      }

      // Re-read: the content script may have queued more rows while we waited.
      const current = await getJobs();
      const at = current.findIndex((j) => (j.jobId || j.url) === (job.jobId || job.url));
      if (at >= 0) {
        current[at] = { ...current[at], ...patch };
        await saveJobs(current);
      }
    }
  } catch (err) {
    await setGenState({ status: "error", note: err.message });
    await log.error(`Generator stopped: ${err.message}`);
  } finally {
    generating = false;
    const state = await getGenState();
    if (state.status !== "running") chrome.alarms.clear(GEN_ALARM);
  }
}

/** Called whenever a JD lands, when the run ends, and from the panel. */
async function kickGenerator(patch) {
  const settings = await getSettings();
  if (!settings.generateDocuments && !(patch && patch.force)) return;
  const state = await getGenState();
  await setGenState({ cancel: false, ...(patch || {}), folder: state.folder || batchFolder(settings) });
  runGenerator();
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== GEN_ALARM || generating) return;
  const state = await getGenState();
  if (state.status === "running" && !state.cancel) runGenerator();
  else chrome.alarms.clear(GEN_ALARM);
});
