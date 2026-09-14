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
    ? `applied ${s.applied} · skipped ${s.skipped} · dry ${s.dryRun} · failed ${s.failed} · no-autofill ${s.noAutofill}`
    : "";

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

chrome.storage.onChanged.addListener(render);
render();
