// Runs inside jobright.ai. Reads job cards, clicks Apply, waits for the company
// tab (the background refocuses Jobright and scrapes the job description there),
// and only then clicks "Yes, I applied!" and queues the job for a matched CV and
// cover letter.
//
// The rules that must not bend:
//   - a company is recorded as applied ONLY after the confirmation click succeeds;
//   - a job whose description could not be read is skipped, not confirmed —
//     a resume written from a guessed JD is worse than no resume.

/* ------------------------------------------------------------------ */
/* Selectors (confirmed against Jobright's DOM, 2026-09-13)            */
/* ------------------------------------------------------------------ */

const SEL = {
  jobCard: 'div[id][class*="index_job-card__"]',
  jobTitle: '[class*="index_job-title__"]',
  companyName: '[class*="index_company-name__"]',
  applyButton: 'button[class*="index_apply-button__"]',
  publishTime: '[class*="index_publish-time__"]',
  metadataItem: '[class*="index_job-metadata-item__"]',
  salaryIcon: 'svg[aria-label="money"]',
  // Jobright's match badge. The class hash changes on deploy, so several shapes are
  // tried and the card's own text is the fallback — see readMatchScore.
  matchScore: '[class*="index_match-score__"], [class*="match-score"], [class*="matchScore"], [class*="index_score__"], [class*="index_match__"]',
  // The ⊘ button on the card (id "index_not_interest_button__xxxx"); opens a
  // dropdown with "Already Applied" / "Not Interested" / "Report Issue".
  notInterestedButton: 'button[id*="not_interest_button"], button[id*="not-interest-button"], [class*="index_actions-group__"] button.ant-dropdown-trigger',
  dropdownMenuItem: ".ant-dropdown .ant-dropdown-menu-item, .ant-dropdown-menu-item, [role=menuitem]",
  alreadyAppliedText: /already\s*applied/i,
  repostedText: /^reposted/i,
  // Button labels. Case is irrelevant (Jobright renders them as "APPLY WITH AUTOFILL",
  // "EASY APPLY", "APPLY NOW"), and they are matched without anchors so a leading icon,
  // a trailing arrow or doubled spacing cannot stop the bot recognising the button.
  // Order matters where they overlap: autofill is tested before the other two.
  applyWithAutofillText: /apply\s*with\s*autofill/i,
  easyApplyText: /\beasy\s*apply\b/i,
  applyNowText: /\bapply\s*now\b/i,
  // Jobright's own detail pane, used for the description when the apply click
  // never opens a company tab (EASY APPLY often applies in place).
  jobDetail: '[class*="index_job-detail"], [class*="jobDetail"], [class*="index_detail"], [class*="job-description"]',
  yesAppliedText: /yes,?\s*i applied/i,
  notAppliedText: /^(no\b.*|not yet\b.*|i('ve| have)? not applied.*)$/i,
  dismissTexts: [/^maybe later$/i, /^not now$/i, /^skip$/i, /^later$/i],
  modal: ".ant-modal, [role=dialog]",
  modalClose: ".ant-modal-close, [aria-label=Close], [aria-label=close]",
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

function readSalary(card) {
  const items = [...card.querySelectorAll(SEL.metadataItem)];
  const byIcon = items.find((el) => el.querySelector(SEL.salaryIcon));
  const item = byIcon || items.find((el) => /^\$\s*\d/.test(text(el)));
  return item ? text(item) : "";
}

// "85% MATCH", "Match 85%", "85 % match" — all seen on the card at one time or another.
const MATCH_RE = /(\d{1,3})\s*%\s*(?:match|fit)?|\b(?:match|fit)(?:\s*score)?\s*[:\-]?\s*(\d{1,3})\s*%/i;

/**
 * The card's match score as a number, or null when the card does not show one.
 *
 * Null is not zero: it means "unknown", and an unknown score must not be treated as
 * a bad one — a changed class name would otherwise silently skip the whole feed.
 */
function readMatchScore(card) {
  const fromBadge = text(card.querySelector(SEL.matchScore));
  const candidates = [fromBadge, text(card).slice(0, 400)].filter(Boolean);
  for (const candidate of candidates) {
    const m = candidate.match(MATCH_RE);
    if (!m) continue;
    const score = Number(m[1] || m[2]);
    if (Number.isFinite(score) && score >= 0 && score <= 100) return score;
  }
  return null;
}

function readJobCard(card) {
  const company = text(card.querySelector(SEL.companyName));
  const title = text(card.querySelector(SEL.jobTitle));
  if (!company) return null;
  const salary = readSalary(card);
  const matchScore = readMatchScore(card);
  const btn = card.querySelector(SEL.applyButton);
  const btnText = text(btn);
  const posted = text(card.querySelector(SEL.publishTime));
  const reposted = SEL.repostedText.test(posted);
  const applyKind = SEL.applyWithAutofillText.test(btnText)
    ? "autofill"
    : SEL.easyApplyText.test(btnText)
      ? "easy-apply"
      : SEL.applyNowText.test(btnText)
        ? "apply-now"
        : "none";
  return { id: card.id || `${title}|${company}`.toLowerCase(), title: title || "(untitled)", company, salary, matchScore, applyKind, button: btn, posted, reposted, card };
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

/**
 * Close "Did you apply?" WITHOUT confirming. Used when the description could not
 * be read: Jobright must not file the job as applied, because we are not applying.
 */
async function declineConfirmation() {
  // Scope the search to the modal itself: "No"-ish labels elsewhere on the page
  // (menus, filters) must never be clicked by accident.
  const yes = findYesAppliedButton();
  const modal = (yes && yes.closest(SEL.modal)) || [...document.querySelectorAll(SEL.modal)].find(isVisible) || null;
  const inModal = modal ? [...modal.querySelectorAll("button, [role=button]")].filter(isVisible) : [];
  const no = inModal.find((b) => SEL.notAppliedText.test(text(b)) && !SEL.yesAppliedText.test(text(b)));
  if (no) {
    no.click();
    await log.info(`Declined the confirmation via "${text(no)}"`);
    await sleep(400);
    return true;
  }
  const closer = [...(modal || document).querySelectorAll(SEL.modalClose)].find(isVisible);
  if (closer) {
    closer.click();
    await sleep(400);
    return true;
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(400);
  return false;
}

/** Real click if the debugger is attached, synthetic otherwise. */
async function clickEl(el) {
  el.scrollIntoView({ block: "center" });
  await sleep(150);
  const r = el.getBoundingClientRect();
  const res = await bg({ type: "trustedClick", x: r.left + r.width / 2, y: r.top + r.height / 2 });
  if (!(res && res.ok)) el.click();
}

function visibleMenuItems() {
  return [...document.querySelectorAll(SEL.dropdownMenuItem)].filter(isVisible);
}

/**
 * ⊘ -> "Already Applied": Jobright moves the card to its Applied list and
 * removes it from the feed. Success = the card actually left the DOM.
 */
async function hideAsAlreadyApplied(card) {
  const btn = card.querySelector(SEL.notInterestedButton);
  if (!btn) {
    await log.warn("Hide: ⊘ button not found on the card");
    return false;
  }
  // antd dropdown trigger: hover opens it; click as a fallback.
  btn.scrollIntoView({ block: "center" });
  for (const type of ["pointerover", "mouseover", "mouseenter"]) btn.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  await sleep(250);
  const findItem = () => visibleMenuItems().find((el) => SEL.alreadyAppliedText.test(text(el)));
  let item = findItem();
  if (!item) await clickEl(btn);
  for (let i = 0; i < 20 && !item; i++) {
    await sleep(150);
    item = findItem();
  }
  if (!item) {
    const seen = visibleMenuItems().map(text);
    await log.warn(`Hide: "Already Applied" menu item did not appear (menu items seen: ${seen.length ? JSON.stringify(seen) : "none"})`);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }

  await clickEl(item);

  // Confirm: the card should leave the list (or Jobright's "Done!" toast shows).
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    if (!card.isConnected || !isVisible(card)) return true;
    if ([...document.querySelectorAll(".ant-message, .ant-notification")].some((el) => /applied/i.test(text(el)))) return true;
  }
  await log.warn("Hide: clicked \"Already Applied\" but the card is still in the list");
  return false;
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
/* Background helpers (tabs / scripting / API live there)              */
/* ------------------------------------------------------------------ */

const bg = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

/**
 * Real click via the DevTools protocol (passes the popup blocker); synthetic fallback.
 *
 * `newTab` adds the Ctrl/Command modifier, so the job opens in a background tab the
 * way it would for a person holding Ctrl — the Jobright tab is never navigated away
 * from, and there is a company page to read the description from.
 */
async function clickForReal(el, { newTab = false } = {}) {
  el.scrollIntoView({ block: "center" });
  await sleep(200);
  const r = el.getBoundingClientRect();
  const res = await bg({ type: "trustedClick", x: r.left + r.width / 2, y: r.top + r.height / 2, newTab });
  if (res && res.ok) return "trusted";

  // Without the debugger a modifier means nothing — Chrome only opens a tab for a
  // trusted click. If the button is (or wraps) a link, open its href directly.
  if (newTab) {
    const anchor = el.closest("a[href]") || el.querySelector("a[href]");
    const href = anchor && anchor.getAttribute("href");
    if (href) {
      await bg({ type: "openTab", url: new URL(href, location.origin).toString() });
      return "opened-link";
    }
  }
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

/** ⊘ -> "Already Applied" so Jobright drops the card from the feed (dry run: log only). */
async function hideCard(job, settings, stats) {
  if (settings.dryRun) {
    await log.dry(`Company: ${job.company} | Action: WOULD HIDE (⊘ -> Already Applied)`);
    return false;
  }
  await sleep(randomBetween(800, 2000));
  if (!(await hideAsAlreadyApplied(job.card))) return false;
  stats.hidden++;
  await log.info('Hidden via ⊘ -> "Already Applied"');
  return true;
}

/** Wait for the company tab that "Apply" opens; it is where the JD lives. */
async function waitForExternalTab(settings, stats) {
  const deadline = Date.now() + settings.newTabTimeout;
  let modalSeenAt = 0;
  while (Date.now() < deadline && !stopRequested) {
    const res = await bg({ type: "check" });
    if (res && res.newTabs && res.newTabs.length) {
      const tab = res.newTabs[0];
      stats.externalTabs++;
      await log.info(`New tab detected (${stats.externalTabs} external tab(s) opened this run): ${tab.url || "(loading)"}`);
      await log.info("Returning to Jobright");
      return tab;
    }
    // Jobright sometimes asks "Did you apply?" before the tab has appeared. Give
    // the tab a moment anyway — it carries the description we came for.
    if (findYesAppliedButton()) {
      if (!modalSeenAt) modalSeenAt = Date.now();
      else if (Date.now() - modalSeenAt > 3000) return null;
    }
    await dismissNagModals();
    await sleep(300);
  }
  return null;
}

/**
 * The description from Jobright's own detail pane.
 *
 * EASY APPLY often submits in place, so no company tab ever opens and there is no
 * employer page to read. Jobright shows the full posting next to the feed, which is
 * the same text — good enough to write a resume from, and recorded as such so the
 * report says where it came from.
 */
async function readJobrightDetail(job, settings) {
  const minLength = Math.max(120, Number(settings.jdMinLength) || 400);
  const before = text(document.querySelector(SEL.jobDetail));

  // Selecting the card is what loads its description into the pane.
  const opener = job.card.querySelector(`${SEL.jobTitle}, a[href]`) || job.card;
  opener.scrollIntoView({ block: "center" });
  opener.click();

  const deadline = Date.now() + 9000;
  while (Date.now() < deadline && !stopRequested) {
    await sleep(300);
    // The biggest block that is still a panel, not the whole feed.
    let best = "";
    for (const el of document.querySelectorAll(SEL.jobDetail)) {
      const value = text(el);
      if (value.length > best.length && value.length < 60000) best = value;
    }
    if (best.length >= minLength && best !== before) {
      return { ok: true, jd: best.slice(0, 12000), via: "jobright detail pane", length: Math.min(best.length, 12000), url: location.href };
    }
  }
  return { ok: false, reason: "no description in Jobright's detail pane" };
}

/** Wait for "Did you apply?" — it can show up before or after the JD is read. */
async function waitForConfirmation(settings) {
  const deadline = Date.now() + settings.confirmationTimeout;
  while (Date.now() < deadline && !stopRequested) {
    const btn = findYesAppliedButton();
    if (btn) return btn;
    await dismissNagModals();
    await sleep(300);
  }
  return null;
}

/** Stores the row and starts the documents. `outcome` records what Jobright was told. */
async function queueForDocuments(job, jd, externalTab, settings, stats, outcome) {
  const queued = await bg({
    type: "queueJob",
    job: {
      jobId: job.id,
      company: job.company,
      title: job.title,
      salary: job.salary || (jd && jd.salary) || "",
      matchScore: job.matchScore,
      posted: job.posted,
      location: (jd && jd.location) || "",
      url: (jd && jd.url) || (externalTab && externalTab.url) || "",
      jd: (jd && jd.jd) || "",
      jdVia: (jd && jd.via) || "",
      jdLength: (jd && jd.length) || 0,
      outcome,
      genStatus: jd && jd.ok && settings.generateDocuments ? "pending" : "off",
    },
  });
  if (queued && queued.ok && jd && jd.ok && settings.generateDocuments) {
    await log.info(`Queued ${job.company} for a matched CV + cover letter (${queued.total} in this batch)`);
    stats.queued++;
  }
  return queued;
}

async function processJob(job, settings, stats) {
  const score = typeof job.matchScore === "number" ? `${job.matchScore}% match` : "no match score";
  await log.info(`Job found: ${job.title} | Company: ${job.company} | ${score}${job.reposted ? ` | ${job.posted}` : ""}`);

  // REPOSTED -> remove from the list via ⊘ -> "Already Applied"
  if (job.reposted) {
    await log.info("Job is reposted -> remove from list");
    await hideCard(job, settings, stats);
    return "reposted";
  }

  // MATCH SCORE — the cheapest filter there is, so it goes first: no click, no tab,
  // no API call for a job the card already says is a poor fit. The card is left in
  // the feed (it is not "applied"), simply passed over.
  const minimum = Number(settings.minMatchScore) || 0;
  if (minimum > 0) {
    if (typeof job.matchScore !== "number") {
      // Unknown is not "bad": skipping here would quietly empty the run if Jobright
      // renamed the badge. It is logged so a vanished score is noticeable.
      await log.warn(`No match score on the card for ${job.company} - processing it anyway`);
      stats.noScore++;
    } else if (job.matchScore < minimum) {
      await log.info(`Match score ${job.matchScore}% is below the ${minimum}% minimum -> SKIP`);
      stats.lowMatch++;
      return "low-match";
    }
  }

  // CHECK_COMPANY -> already applied (local history, or the app's own 30-day rule)
  const dup = await bg({ type: "checkDuplicate", company: job.company });
  if (dup && dup.duplicate) {
    await log.info(`Company already applied${dup.via === "app" ? " (found in the resume builder)" : ""} -> remove from list`);
    await hideCard(job, settings, stats);
    return "skipped";
  }
  await log.info(`Company is new${job.salary ? ` | ${job.salary}` : ""}`);

  if (job.applyKind === "apply-now" && settings.applyNowBehavior === "skip") {
    await log.warn(`Card shows "APPLY NOW" (no autofill) for ${job.company} -> SKIP (applyNowBehavior=skip)`);
    return "no-autofill";
  }
  if (job.applyKind === "easy-apply" && settings.easyApplyBehavior === "skip") {
    await log.warn(`Card shows "EASY APPLY" for ${job.company} -> SKIP (easyApplyBehavior=skip)`);
    return "no-autofill";
  }
  if (job.applyKind === "none" || !job.button) {
    await log.error(`Apply button not found for ${job.company} -> SKIP`);
    return "failed";
  }
  job.button.scrollIntoView({ block: "center" });

  if (settings.dryRun) {
    await log.dry(`Company: ${job.company} | Status: NEW | Action: WOULD CLICK APPLY (JD + documents skipped in dry run)`);
    await bg({
      type: "updateJob",
      job: { jobId: job.id, company: job.company, title: job.title, salary: job.salary, matchScore: job.matchScore, posted: job.posted, genStatus: "off", outcome: "would apply" },
    });
    return "dry-run";
  }

  // CLICK_APPLY -> the company tab opens; the background refocuses Jobright.
  await dismissNagModals();
  const BUTTON_LABEL = { autofill: "Apply with Autofill", "easy-apply": "EASY APPLY", "apply-now": "APPLY NOW" };
  await log.info(`Clicking ${BUTTON_LABEL[job.applyKind] || "Apply"}`);
  await bg({ type: "arm" });
  let externalTab = null;
  try {
    // EASY APPLY tends to act inside Jobright; Ctrl-clicking it opens the employer's
    // page in a background tab instead, which is where the description lives.
    const withModifier = settings.ctrlClickKinds !== false && job.applyKind === "easy-apply";
    const how = await clickForReal(job.button, { newTab: withModifier });
    if (withModifier && how === "trusted") await log.info("Ctrl-clicked, so the job opens in a background tab");
    if (how === "opened-link") await log.info("Debugger unavailable - opened the job's link in a new tab instead");
    if (how === "synthetic") await log.warn("Debugger unavailable - used a synthetic click (new tab may be blocked by Chrome)");
    externalTab = await waitForExternalTab(settings, stats);
  } finally {
    await bg({ type: "disarm" });
  }

  // READ_JD on the company's own job page (a different origin, so the background
  // does the scraping). No description -> this job is not for us.
  let jd = null;
  if (settings.scrapeJd) {
    if (!externalTab) {
      await log.warn(`No company tab appeared for ${job.company} - cannot read the job description`);
    } else {
      await setStatus({ current: `${job.title} | ${job.company} — reading the job description...` });
      const res = await bg({ type: "scrapeJd", tabId: externalTab.id });
      jd = (res && res.result) || null;
      if (jd && jd.ok) await log.info(`Job description captured: ${jd.length} chars (${jd.via})`);
      else await log.warn(`Job description NOT captured for ${job.company}: ${(jd && jd.reason) || "unknown reason"}`);
    }

    // No employer page, or an unreadable one: Jobright's own pane is the fallback.
    if (!(jd && jd.ok) && settings.jobrightDetailFallback !== false) {
      const fromPane = await readJobrightDetail(job, settings);
      if (fromPane.ok) {
        await log.info(`Job description taken from Jobright's detail pane: ${fromPane.length} chars`);
        jd = fromPane;
      } else {
        await log.warn(`Jobright's detail pane had no description for ${job.company} either`);
      }
    }

    if (settings.requireJd && !(jd && jd.ok)) {
      const reason = (jd && jd.reason) || (externalTab ? "no job description found" : "no company tab opened");
      await bg({
        type: "updateJob",
        job: {
          jobId: job.id,
          company: job.company,
          title: job.title,
          salary: job.salary,
          matchScore: job.matchScore,
          posted: job.posted,
          url: (jd && jd.url) || (externalTab && externalTab.url) || "",
          genStatus: "skipped",
          genError: reason,
          outcome: "skipped",
        },
      });
      // Jobright asks "Did you apply?" — answer honestly: we did not.
      if (await waitForConfirmation({ ...settings, confirmationTimeout: 5000 })) await declineConfirmation();
      await log.warn(`Skipped ${job.company} (${reason}) - not marked as applied`);
      return "no-jd";
    }
  }

  // WAIT_FOR_CONFIRMATION -> CLICK_YES_APPLIED
  let yesButton = await waitForConfirmation(settings);
  if (!yesButton) {
    await log.warn(
      externalTab
        ? `Confirmation modal did not appear for ${job.company} - NOT marking as applied`
        : `Neither a new tab nor "Did you apply?" appeared for ${job.company} - NOT marking as applied`,
    );
    await logFailureDiagnostics();

    // A Ctrl-click often means Jobright never asks. The description is already in
    // hand, so write the documents anyway — but say plainly that the card was left
    // unconfirmed, and keep the company out of the applied history.
    if (jd && jd.ok) {
      await queueForDocuments(job, jd, externalTab, settings, stats, "not marked applied");
      await log.info(`Documents queued for ${job.company} without confirming - apply yourself from the JD link`);
      return "documents-only";
    }

    if (!externalTab && settings.onNewTabTimeout === "stop") throw new Error("Stopping per onNewTabTimeout=stop");
    return "failed";
  }
  if (!externalTab) await log.warn("Confirmation modal appeared but no new tab was detected - proceeding on the modal");
  await log.info("Confirmation modal detected");

  // Pause like a person reading the modal first.
  const pause = randomBetween(settings.confirmDelayMin, settings.confirmDelayMax);
  await log.info(`Waiting ${(pause / 1000).toFixed(1)}s before confirming`);
  await sleep(pause);
  if (!isVisible(yesButton)) yesButton = findYesAppliedButton(); // the modal may have re-rendered
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

  // QUEUE_DOCUMENTS - the generator (background) writes the CV, the cover letter
  // and the Excel row while the bot moves on to the next job.
  await queueForDocuments(job, jd, externalTab, settings, stats, "applied");
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
  const stats = { applied: 0, skipped: 0, hidden: 0, failed: 0, dryRun: 0, noAutofill: 0, reposted: 0, unreadable: 0, externalTabs: 0, noJd: 0, queued: 0, lowMatch: 0, noScore: 0, documentsOnly: 0 };
  const seen = new Set();
  let scrollRounds = 0;
  const historyCount = Object.keys(await getHistory()).length;

  await setStatus({ running: true, stats, current: "" });
  const minimum = Number(settings.minMatchScore) || 0;
  await log.info(`Mode: ${settings.dryRun ? "DRY RUN (no clicks)" : "LIVE"} | history has ${historyCount} companies | max applies this run: ${settings.maxApplicationsPerRun}${minimum ? ` | only ${minimum}% match and above` : ""}`);
  if (!settings.dryRun) {
    await log.info(
      settings.scrapeJd
        ? `Job descriptions are read from each company's own page${settings.requireJd ? " (no description -> job skipped)" : ""}`
        : "JD capture is off - no documents will be generated",
    );
  }

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
        else if (outcome === "no-jd") stats.noJd++;
        else if (outcome === "low-match") { /* counted where it is decided */ }
        else if (outcome === "documents-only") stats.documentsOnly++;
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
    await log.info(
      `Summary -> applied: ${stats.applied}, skipped: ${stats.skipped} (hidden ${stats.hidden}), low match: ${stats.lowMatch}, documents without confirming: ${stats.documentsOnly}, no JD: ${stats.noJd}, queued for documents: ${stats.queued}, would-apply(dry): ${stats.dryRun}, failed: ${stats.failed}, no-autofill: ${stats.noAutofill}, reposted: ${stats.reposted}, unreadable: ${stats.unreadable}`,
    );
    running = false;
    delete document.documentElement.dataset.jrbotRunning;
    await bg({ type: "runEnded" }); // drains the document queue and writes jobs.xlsx
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
