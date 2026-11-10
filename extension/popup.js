const $ = (id) => document.getElementById(id);

async function render() {
  const [settings, status, { log: lines }, history, jobs, genState, apiUser] = await Promise.all([
    getSettings(),
    getStatus(),
    chrome.storage.local.get("log"),
    getHistory(),
    getJobs(),
    chrome.storage.local.get("genState").then((r) => r.genState || {}),
    getApiUser(),
  ]);

  $("dryRun").checked = !!settings.dryRun;
  $("maxApplicationsPerRun").value = settings.maxApplicationsPerRun;
  $("minMatchScore").value = settings.minMatchScore ?? 70;
  $("generateDocuments").checked = !!settings.generateDocuments;
  $("template").value = settings.template || "classic";
  $("keepTabs").checked = !settings.closeExternalTabs;
  $("historyCount").textContent = `History: ${Object.keys(history).length} companies`;
  $("apiUser").textContent = apiUser && apiUser.email ? `as ${apiUser.email}` : "not signed in";
  $("apiUser").style.opacity = apiUser && apiUser.email ? ".7" : "1";
  $("apiUser").style.color = apiUser && apiUser.email ? "" : "#e55";

  const running = !!status.running;
  $("status").textContent = running ? (settings.dryRun ? "running (dry run)" : "running (LIVE)") : "idle";
  $("status").className = running ? "running" : "";
  $("start").disabled = running;
  $("startOffline").disabled = running;
  $("stop").disabled = !running;
  $("current").textContent = status.current ? `▶ ${status.current}` : "";

  const s = status.stats;
  $("stats").textContent = s
    ? `applied ${s.applied} · skipped ${s.skipped} (hidden ${s.hidden || 0}) · low match ${s.lowMatch || 0} · no JD ${s.noJd || 0} · docs queued ${s.queued || 0} · dry ${s.dryRun} · failed ${s.failed} · no-autofill ${s.noAutofill} · reposted ${s.reposted || 0}`
    : "";

  renderGen(genState, jobs);
  renderJobs(jobs);
  $("clearJobs").hidden = running;

  const logEl = $("log");
  logEl.innerHTML = (lines || [])
    .map((l) => {
      const cls = /\] ERROR /.test(l) ? "error" : /\] WARN /.test(l) ? "warn" : /\] \[DRY RUN\] /.test(l) ? "dry" : "";
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = l;
      return span.outerHTML;
    })
    .join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

/* ------------------------------------------------------------------ */
/* Document generation progress                                        */
/* ------------------------------------------------------------------ */

const GEN_LABEL = {
  running: "Generating documents",
  waiting: "Documents up to date",
  stopping: "Stopping…",
  stopped: "Generation stopped",
  done: "Documents finished",
  error: "Generation error",
  idle: "Waiting for the first job",
};

function renderGen(state, jobs) {
  const el = $("gen");
  const pending = jobs.filter((j) => j.genStatus === "pending").length;
  const generated = jobs.filter((j) => j.genStatus === "generated").length;
  const failed = jobs.filter((j) => j.genStatus === "failed").length;

  if (!state.status && !jobs.length) {
    el.className = "hidden";
    el.replaceChildren();
    return;
  }
  el.className = state.status === "error" ? "error" : state.status === "done" ? "done" : "";

  const total = generated + failed + pending;
  const pct = total ? Math.round(((generated + failed) / total) * 100) : 0;
  const head = document.createElement("div");
  const label = document.createElement("b");
  label.textContent = GEN_LABEL[state.status] || "Documents";
  head.appendChild(label);
  head.appendChild(
    document.createTextNode(
      ` ${generated} ready${failed ? `, ${failed} failed` : ""}${pending ? `, ${pending} queued` : ""}`,
    ),
  );

  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("span");
  fill.style.width = `${pct}%`;
  bar.appendChild(fill);

  el.replaceChildren(head, bar);
  if (state.note) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = state.note;                      // textContent: company names come from the page
    el.appendChild(note);
  }
  $("retryBtn").disabled = !failed;
}

/* ------------------------------------------------------------------ */
/* Batch list                                                          */
/* ------------------------------------------------------------------ */

const BADGE = {
  generated: "CV ready",
  pending: "queued",
  failed: "failed",
  skipped: "no JD",
  off: "applied",
};

function renderJobs(jobs) {
  $("jobsCount").textContent = jobs.length ? `(${jobs.length})` : "";
  const el = $("jobs");
  el.replaceChildren();
  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Jobs handled during a run show up here with their CV and cover letter.";
    el.appendChild(empty);
    return;
  }

  const mk = (tag, cls, txt, title) => {
    const d = document.createElement(tag);
    d.className = cls;
    d.textContent = txt;
    if (title) d.title = title;
    return d;
  };

  for (const job of [...jobs].reverse()) {
    const row = document.createElement("div");
    row.className = "job";
    const state = job.genStatus || "pending";
    row.appendChild(mk("div", "title", job.title || "(untitled)", job.title));
    row.appendChild(mk("div", `badge ${state}`, job.outcome === "would apply" && state === "off" ? "would apply" : BADGE[state] || state));

    const meta = mk("div", "meta", "", `${job.company}${job.salary ? " · " + job.salary : ""}`);
    meta.appendChild(mk("span", "company", job.company || ""));
    meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(mk("span", job.salary ? "salary" : "salary none", job.salary || "no salary listed"));
    if (typeof job.matchScore === "number") meta.appendChild(document.createTextNode(` · ${job.matchScore}% match`));
    if (job.jdLength) meta.appendChild(document.createTextNode(` · JD ${job.jdLength} chars`));
    row.appendChild(meta);
    row.appendChild(mk("div", "at", (job.generatedAt || job.collectedAt || "").slice(11, 19)));
    if (job.genError) row.appendChild(mk("div", "err", job.genError, job.genError));
    el.appendChild(row);
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function send(msg) {
  $("err").textContent = "";
  const res = await chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));
  if (!res || !res.ok) $("err").textContent = (res && res.error) || "No response from background";
  return res;
}

$("start").addEventListener("click", () => send({ type: "start" }));
$("startOffline").addEventListener("click", () => send({ type: "start", offline: true }));
$("stop").addEventListener("click", () => send({ type: "stop" }));
$("openWindow").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.windows.create({ url: "popup.html", type: "popup", width: 460, height: 640 });
});
$("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
$("dryRun").addEventListener("change", (e) => saveSettings({ dryRun: e.target.checked }));
$("maxApplicationsPerRun").addEventListener("change", (e) =>
  saveSettings({ maxApplicationsPerRun: Math.max(0, parseInt(e.target.value, 10) || 0) }),
);
$("minMatchScore").addEventListener("change", (e) =>
  saveSettings({ minMatchScore: Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0)) }),
);
$("generateDocuments").addEventListener("change", (e) => saveSettings({ generateDocuments: e.target.checked }));
$("template").addEventListener("change", (e) => saveSettings({ template: e.target.value }));
$("keepTabs").addEventListener("change", (e) => saveSettings({ closeExternalTabs: !e.target.checked }));

$("excelBtn").addEventListener("click", async () => {
  const res = await send({ type: "writeExcelNow" });
  if (res && res.ok) $("err").textContent = "";
});
$("retryBtn").addEventListener("click", () => send({ type: "retryFailed" }));

$("clearJobs").addEventListener("click", async (e) => {
  e.preventDefault();
  await send({ type: "clearJobs" });
});
$("toggleLog").addEventListener("click", (e) => {
  e.preventDefault();
  const collapsed = $("logWrap").classList.toggle("collapsed");
  $("toggleLog").textContent = collapsed ? "show ▸" : "hide ▾";
  localStorage.setItem("logCollapsed", collapsed ? "1" : "");
});
if (localStorage.getItem("logCollapsed")) {
  $("logWrap").classList.add("collapsed");
  $("toggleLog").textContent = "show ▸";
}

chrome.storage.onChanged.addListener(render);
render();
