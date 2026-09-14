// Runs inside jobright.ai. Reads job cards, clicks Apply, waits for the
// external tab (background refocuses Jobright) and the "Did you apply?"
// modal, clicks "Yes, I applied!", records the company. Same rules as the
// Node bot: a company is saved ONLY after that confirmation click succeeds.

/* ------------------------------------------------------------------ */
/* Selectors (confirmed against Jobright's DOM, 2026-09-13)            */
/* ------------------------------------------------------------------ */

const SEL = {
  jobCard: 'div[id][class*="index_job-card__"]',
  jobTitle: '[class*="index_job-title__"]',
  companyName: '[class*="index_company-name__"]',
  applyButton: 'button[class*="index_apply-button__"]',
  publishTime: '[class*="index_publish-time__"]',
  notInterestedButton: 'button[id*="not-interest-button"]', // the ⊘ button on the card
  dropdownMenuItem: ".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item, [role=menuitem]",
  alreadyAppliedText: /^already applied$/i,
  repostedText: /^reposted/i,
  applyWithAutofillText: /apply with autofill/i,
  applyNowText: /^apply now$/i,
  yesAppliedText: /yes,?\s*i applied/i,
  dismissTexts: [/^maybe later$/i, /^not now$/i, /^skip$/i, /^later$/i],
  modal: ".ant-modal, [role=dialog]",
  jobListScroller: '[class*="jobs-list-scrollable"]',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomBetween = (min, max) => {
  const lo = Math.max(0, Math.min(min, max));
  const hi = Math.max(min, max);
  return lo + Math.random() * (hi - lo);
};
const text = (el) => (el ? el.textContent || "" : "").replace(/\s+/g, " ").trim();
const isVisible = (el) => !!el && el.offsetParent !== null && el.getClientRects().length > 0;

function buttonsMatching(re) {
  return [...document.querySelectorAll("button, [role=button]")].filter((b) => isVisible(b) && re.test(text(b)));
}

/* ------------------------------------------------------------------ */
/* Reading the list                                                    */
/* ------------------------------------------------------------------ */

function getJobCards() {
  return [...document.querySelectorAll(SEL.jobCard)];
}

function readJobCard(card) {
  const company = text(card.querySelector(SEL.companyName));
  const title = text(card.querySelector(SEL.jobTitle));
  if (!company) return null;
  const btn = card.querySelector(SEL.applyButton);
  const btnText = text(btn);
  const posted = text(card.querySelector(SEL.publishTime));
  const reposted = SEL.repostedText.test(posted);
  const applyKind = SEL.applyWithAutofillText.test(btnText)
    ? "autofill"
    : SEL.applyNowText.test(btnText)
      ? "apply-now"
      : "none";
  return { id: card.id || `${title}|${company}`.toLowerCase(), title: title || "(untitled)", company, applyKind, button: btn, posted, reposted, card };
}

function scrollJobList() {
  const scroller = document.querySelector(SEL.jobListScroller);
  if (scroller) scroller.scrollBy(0, scroller.clientHeight * 2);
  else window.scrollBy(0, 2000);
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

function findYesAppliedButton() {
  return buttonsMatching(SEL.yesAppliedText)[0] || null;
}

async function dismissNagModals() {
  let dismissed = false;
  for (const re of SEL.dismissTexts) {
    const btn = buttonsMatching(re)[0];
    if (btn) {
      btn.click();
      await log.info(`Dismissed modal via "${text(btn)}"`);
      dismissed = true;
      await sleep(400);
    }
  }
  return dismissed;
}

/** ⊘ -> "Already Applied": Jobright moves the card to the Applied list. */
async function hideAsAlreadyApplied(card) {
  const btn = card.querySelector(SEL.notInterestedButton);
  if (!btn) {
    await log.warn("Hide: ⊘ button not found on the card");
    return false;
  }
  btn.scrollIntoView({ block: "center" });
  await sleep(150);
  btn.click();
  let item = null;
  for (let i = 0; i < 20 && !item; i++) {
    await sleep(150);
    item = [...document.querySelectorAll(SEL.dropdownMenuItem)].find((el) => isVisible(el) && SEL.alreadyAppliedText.test(text(el)));
  }
  if (!item) {
    await log.warn('Hide: "Already Applied" menu item did not appear');
    document.body.click(); // close whatever opened
    return false;
  }
  item.click();
  await sleep(600);
  return true;
}

function describeOpenModals() {
  return [...document.querySelectorAll(SEL.modal)].filter(isVisible).map((m) => text(m).slice(0, 300));
}

async function logFailureDiagnostics() {
  const modals = describeOpenModals();
  await log.warn(`Diagnostics: open modals: ${modals.length ? JSON.stringify(modals) : "none"}`);
  if (modals.some((t) => /extension/i.test(t))) {
    await log.warn('A modal mentions "extension" - the Jobright Autofill extension is probably not installed in this browser profile.');
  }
}

/* ------------------------------------------------------------------ */
/* Background helpers (tabs API lives there)                           */
/* ------------------------------------------------------------------ */

const bg = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

/** Real click via DevTools protocol (passes the popup blocker); synthetic fallback. */
async function clickForReal(el) {
  el.scrollIntoView({ block: "center" });
  await sleep(200);
  const r = el.getBoundingClientRect();
  const res = await bg({ type: "trustedClick", x: r.left + r.width / 2, y: r.top + r.height / 2 });
  if (res && res.ok) return "trusted";
  el.click();
  return "synthetic";
}

// page-bridge.js (page world) reports a blocked window.open here.
window.addEventListener("message", (ev) => {
  if (ev.source !== window || !ev.data || ev.data.source !== "jrbot") return;
  if (ev.data.type === "openTab" && running) {
    log.warn("Page's window.open was blocked - opening the company tab via the extension");
    bg({ type: "openTab", url: ev.data.url });
  }
});

/* ------------------------------------------------------------------ */
/* Per-job state machine                                               */
/* ------------------------------------------------------------------ */

let running = false;
let stopRequested = false;

async function processJob(job, settings, stats) {
  await log.info(`Job found: ${job.title} | Company: ${job.company}${job.reposted ? ` | ${job.posted}` : ""}`);

  // REPOSTED -> skip before anything else
  if (job.reposted && settings.skipReposted) {
    await log.info("Job is reposted -> SKIP");
    return "reposted";
  }

  // CHECK_COMPANY
  if (await hasApplied(job.company)) {
    await log.info("Company already applied -> SKIP");
    if (settings.hideAppliedJobs) {
      if (settings.dryRun) {
        await log.dry(`Company: ${job.company} | Action: WOULD HIDE (⊘ -> Already Applied)`);
      } else {
        await sleep(randomBetween(800, 2000));
        if (await hideAsAlreadyApplied(job.card)) {
          stats.hidden++;
          await log.info('Hidden via ⊘ -> "Already Applied"');
        }
      }
    }
    return "skipped";
  }
  await log.info("Company is new");

  if (job.applyKind === "apply-now" && settings.applyNowBehavior === "skip") {
    await log.warn(`Card shows "APPLY NOW" (no autofill) for ${job.company} -> SKIP (applyNowBehavior=skip)`);
    return "no-autofill";
  }
  if (job.applyKind === "none" || !job.button) {
    await log.error(`Apply button not found for ${job.company} -> SKIP`);
    return "failed";
  }
  job.button.scrollIntoView({ block: "center" });

  if (settings.dryRun) {
    await log.dry(`Company: ${job.company} | Status: NEW | Action: WOULD CLICK APPLY`);
    return "dry-run";
  }

  // CLICK_APPLY -> race: new tab (background refocuses us) / "Did you apply?"
  await dismissNagModals();
  await log.info(job.applyKind === "autofill" ? "Clicking Apply with Autofill" : "Clicking APPLY NOW");
  await bg({ type: "arm" });
  let externalTab = null;
  let yesButton = null;
  try {
    const how = await clickForReal(job.button);
    if (how === "synthetic") await log.warn("Debugger unavailable - used a synthetic click (new tab may be blocked by Chrome)");
    const deadline = Date.now() + settings.newTabTimeout + settings.confirmationTimeout;
    while (Date.now() < deadline && !stopRequested) {
      if (!externalTab) {
        const res = await bg({ type: "check" });
        if (res && res.newTabs && res.newTabs.length) {
          externalTab = res.newTabs[0];
          stats.externalTabs++;
          await log.info(`New tab detected (${stats.externalTabs} external tab(s) open): ${externalTab.url || "(loading)"}`);
          await log.info("Returning to Jobright");
        }
      }
      yesButton = findYesAppliedButton();
      if (yesButton) break;
      await dismissNagModals();
      await sleep(300);
    }
  } finally {
    await bg({ type: "disarm" });
  }

  if (!yesButton) {
    await log.error(
      externalTab
        ? `Confirmation modal did not appear for ${job.company} - NOT marking as applied`
        : `Neither a new tab nor "Did you apply?" appeared for ${job.company} - NOT marking as applied`,
    );
    await logFailureDiagnostics();
    if (!externalTab && settings.onNewTabTimeout === "stop") throw new Error("Stopping per onNewTabTimeout=stop");
    return "failed";
  }
  if (!externalTab) await log.warn("Confirmation modal appeared but no new tab was detected - proceeding on the modal");
  await log.info("Confirmation modal detected");

  // CLICK_YES_APPLIED - pause like a person reading the modal first.
  const pause = randomBetween(settings.confirmDelayMin, settings.confirmDelayMax);
  await log.info(`Waiting ${(pause / 1000).toFixed(1)}s before confirming`);
  await sleep(pause);
  if (!isVisible(yesButton)) yesButton = findYesAppliedButton(); // modal may have re-rendered
  if (!yesButton) {
    await log.error(`"Yes, I applied!" disappeared before it was clicked for ${job.company} - NOT marking as applied`);
    return "failed";
  }
  await log.info('Clicking "Yes, I applied!"');
  yesButton.click(); // no popup involved - a synthetic click is fine here
  await sleep(500);

  // SAVE_COMPANY - only reached after the confirmation click.
  const added = await addToHistory([job.company], "bot");
  await log.info(added ? `${job.company} added to applied-company history` : `${job.company} was already in history (no duplicate created)`);
  return "applied";
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */

async function runBot() {
  if (running) return;
  running = true;
  stopRequested = false;
  document.documentElement.dataset.jrbotRunning = "1";
  const settings = await getSettings();
  const stats = { applied: 0, skipped: 0, hidden: 0, failed: 0, dryRun: 0, noAutofill: 0, reposted: 0, unreadable: 0, externalTabs: 0 };
  const seen = new Set();
  let scrollRounds = 0;
  const historyCount = Object.keys(await getHistory()).length;

  await setStatus({ running: true, stats, current: "" });
  await log.info(`Mode: ${settings.dryRun ? "DRY RUN (no clicks)" : "LIVE"} | history has ${historyCount} companies | max applies this run: ${settings.maxApplicationsPerRun}`);

  try {
    outer: while (!stopRequested) {
      await dismissNagModals();
      const cards = getJobCards();
      let newCardsThisPass = 0;

      for (const card of cards) {
        if (stopRequested) break outer;
        if (stats.applied >= settings.maxApplicationsPerRun) {
          await log.info(`Reached max applications per run (${settings.maxApplicationsPerRun}) - stopping`);
          break outer;
        }
        if (!card.isConnected) continue; // list re-rendered (e.g. after a hide); next pass picks it up
        const job = readJobCard(card);
        if (!job) {
          stats.unreadable++;
          await log.error("Company name could not be extracted from job card -> SKIP (no Apply click)");
          continue;
        }
        if (seen.has(job.id)) continue;
        seen.add(job.id);
        newCardsThisPass++;
        await setStatus({ stats, current: `${job.title} | ${job.company}` });

        const outcome = await processJob(job, settings, stats);
        if (outcome === "skipped") stats.skipped++;
        else if (outcome === "applied") stats.applied++;
        else if (outcome === "failed") stats.failed++;
        else if (outcome === "no-autofill") stats.noAutofill++;
        else if (outcome === "reposted") stats.reposted++;
        else stats.dryRun++;
        await setStatus({ stats });

        await bg({ type: "focusJobright" }); // AC-08: always operate from Jobright
        await sleep(settings.delayBetweenJobs);
      }

      if (newCardsThisPass === 0) {
        if (scrollRounds >= settings.maxScrollRounds) {
          await log.info("No new jobs after scrolling - done");
          break;
        }
        scrollRounds++;
        await log.info(`Scrolling for more jobs (round ${scrollRounds}/${settings.maxScrollRounds})`);
        scrollJobList();
        await sleep(1500);
      }
    }
  } catch (err) {
    await log.error(err.message);
  } finally {
    if (stopRequested) await log.warn("Stopped by user");
    await log.info(`Summary -> applied: ${stats.applied}, skipped: ${stats.skipped} (hidden ${stats.hidden}), would-apply(dry): ${stats.dryRun}, failed: ${stats.failed}, no-autofill: ${stats.noAutofill}, reposted: ${stats.reposted}, unreadable: ${stats.unreadable}`);
    running = false;
    delete document.documentElement.dataset.jrbotRunning;
    await bg({ type: "runEnded" });
    await setStatus({ running: false, stats, current: "" });
  }
}

/* ------------------------------------------------------------------ */
/* Messages from background/popup                                      */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "start") {
    runBot();
    sendResponse({ ok: true });
  } else if (msg.type === "stop") {
    stopRequested = true;
    sendResponse({ ok: true });
  } else if (msg.type === "ping") {
    sendResponse({ ok: true, running });
  }
});

// A page reload kills any in-flight run; make the popup reflect that.
setStatus({ running: false, current: "" });
