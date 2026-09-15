const $ = (id) => document.getElementById(id);

async function render() {
  const [settings, status, { log: lines }, history] = await Promise.all([
    getSettings(),
    getStatus(),
    chrome.storage.local.get("log"),
    getHistory(),
  ]);

  $("dryRun").checked = !!settings.dryRun;
  $("maxApplicationsPerRun").value = settings.maxApplicationsPerRun;
  $("historyCount").textContent = `History: ${Object.keys(history).length} companies`;

  const running = !!status.running;
  $("status").textContent = running ? (settings.dryRun ? "running (dry run)" : "running (LIVE)") : "idle";
  $("status").className = running ? "running" : "";
  $("start").disabled = running;
  $("startOffline").disabled = running;
  $("stop").disabled = !running;
  $("current").textContent = status.current ? `▶ ${status.current}` : "";

  const s = status.stats;
  $("stats").textContent = s
    ? `applied ${s.applied} · skipped ${s.skipped} (hidden ${s.hidden || 0}) · dry ${s.dryRun} · failed ${s.failed} · no-autofill ${s.noAutofill} · reposted ${s.reposted || 0}`
    : "";

  renderJobs(status.appliedJobs || []);
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

const OUTCOME_LABEL = { applied: "applied", "dry-run": "would apply" };

function renderJobs(jobs) {
  $("jobsCount").textContent = jobs.length ? `(${jobs.length})` : "";
  const el = $("jobs");
  el.replaceChildren();
  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Jobs the bot applies to during a run show up here.";
    el.appendChild(empty);
    return;
  }
  for (const j of jobs) {
    const row = document.createElement("div");
    row.className = "job";
    const mk = (tag, cls, txt, title) => {
      const d = document.createElement(tag);
      d.className = cls;
      d.textContent = txt;
      if (title) d.title = title;
      return d;
    };
    const outcome = j.outcome || "applied";
    row.appendChild(mk("div", "title", j.title, j.title));
    row.appendChild(mk("div", `badge ${outcome}`, OUTCOME_LABEL[outcome] || outcome));
    const meta = mk("div", "meta", "", `${j.company}${j.salary ? " · " + j.salary : ""}`);
    meta.appendChild(mk("span", "company", j.company));
    meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(mk("span", j.salary ? "salary" : "salary none", j.salary || "no salary listed"));
    row.appendChild(meta);
    row.appendChild(mk("div", "at", j.at || ""));
    el.appendChild(row);
  }
}

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

$("clearJobs").addEventListener("click", async (e) => {
  e.preventDefault();
  await setStatus({ appliedJobs: [] });
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
