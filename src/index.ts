import readline from "node:readline";
import type { BrowserContext, Locator, Page } from "playwright";
import { config } from "./config.js";
import { log } from "./logger.js";
import { launchBrowser, isLoggedIn } from "./browser.js";
import { CompanyHistory } from "./company-history.js";
import { TabManager } from "./tab-manager.js";
import { syncFromResumeBuilder } from "./remote-history.js";
import {
  getJobCards,
  readJobCard,
  findApplyButton,
  findYesAppliedButton,
  dismissNagModals,
  saveFailureSnapshot,
  scrollJobList,
  inspectPage,
  type JobInfo,
} from "./jobright.js";

/* ------------------------------------------------------------------ */
/* Graceful stop (Ctrl+C)                                              */
/* ------------------------------------------------------------------ */

let stopRequested = false;
process.on("SIGINT", () => {
  if (stopRequested) process.exit(130);
  stopRequested = true;
  log.warn("Stop requested (Ctrl+C) - finishing current job, then exiting. Press again to force.");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomBetween = (min: number, max: number) => {
  const lo = Math.max(0, Math.min(min, max));
  const hi = Math.max(min, max);
  return lo + Math.random() * (hi - lo);
};

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(prompt, () => {
      rl.close();
      resolve();
    }),
  );
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

/* ------------------------------------------------------------------ */
/* Per-job state machine                                               */
/* ------------------------------------------------------------------ */

type Outcome = "skipped" | "applied" | "failed" | "dry-run" | "no-autofill" | "reposted";

async function processJob(
  card: Locator,
  job: JobInfo,
  history: CompanyHistory,
  tabs: TabManager,
): Promise<Outcome> {
  const page = tabs.jobright;
  log.info(`Job found: ${job.title} | Company: ${job.company}${job.reposted ? ` | ${job.posted}` : ""}`);

  // REPOSTED -> skip before anything else
  if (job.reposted && config.skipReposted) {
    log.info("Job is reposted -> SKIP");
    return "reposted";
  }

  // CHECK_COMPANY
  if (history.hasApplied(job.company)) {
    log.info("Company already applied -> SKIP");
    return "skipped";
  }
  log.info("Company is new");

  // CLICK_APPLY (locate first)
  if (job.applyKind === "apply-now" && config.applyNowBehavior === "skip") {
    log.warn(`Card shows "APPLY NOW" (no autofill) for ${job.company} -> SKIP (APPLY_NOW_BEHAVIOR=skip)`);
    return "no-autofill";
  }
  tabs.assertJobrightAlive();
  const applyButton = job.applyKind === "none" ? null : await findApplyButton(card);
  if (!applyButton) {
    log.error(`Apply button not found for ${job.company} -> SKIP`);
    return "failed";
  }

  if (config.dryRun) {
    log.dry(`Company: ${job.company} | Status: NEW | Action: WOULD CLICK APPLY`);
    return "dry-run";
  }

  // CLICK_APPLY -> WAIT_FOR_NEW_TAB / WAIT_FOR_CONFIRMATION
  // Jobright normally opens the external tab first and shows "Did you apply?"
  // afterwards, but the order and timing vary, so we race both: whichever
  // shows up first is progress. Nag modals ("Maybe later") are dismissed on
  // every tick so they never block anything.
  await dismissNagModals(page);
  log.info("Clicking Apply with Autofill");
  const watcher = tabs.watchForNewTab();
  let externalTab: Page | null = null;
  let yesButton: Locator | null = null;
  try {
    try {
      await applyButton.click({ timeout: 10_000 });
    } catch (err) {
      log.error(`Could not click Apply for ${job.company} - NOT marking as applied (${firstLine(err)})`);
      await saveFailureSnapshot(page, job.company);
      return "failed";
    }

    const deadline = Date.now() + config.newTabTimeout + config.confirmationTimeout;
    let returned = false;
    while (Date.now() < deadline) {
      if (!externalTab) {
        externalTab = watcher.found();
        if (externalTab) tabs.registerExternalTab(externalTab);
      }
      // RETURN_TO_JOBRIGHT - immediately, without touching the external tab.
      if (externalTab && !returned) {
        await tabs.returnToJobright();
        returned = true;
      }
      yesButton = await findYesAppliedButton(page);
      if (yesButton) break;
      await dismissNagModals(page);
      await sleep(300);
    }
  } finally {
    watcher.stop();
  }

  if (!yesButton) {
    log.error(
      externalTab
        ? `Confirmation modal did not appear for ${job.company} - NOT marking as applied`
        : `Neither a new tab nor "Did you apply?" appeared for ${job.company} - NOT marking as applied`,
    );
    await saveFailureSnapshot(page, job.company);
    if (!externalTab && config.onNewTabTimeout === "stop") throw new Error("Stopping per ON_NEW_TAB_TIMEOUT=stop");
    return "failed";
  }
  if (!externalTab) log.warn("Confirmation modal appeared but no new tab was detected - proceeding on the modal");
  log.info("Confirmation modal detected");

  // CLICK_YES_APPLIED - pause like a person reading the modal first.
  const pause = randomBetween(config.confirmDelayMin, config.confirmDelayMax);
  log.info(`Waiting ${(pause / 1000).toFixed(1)}s before confirming`);
  await sleep(pause);
  try {
    log.info('Clicking "Yes, I applied!"');
    await yesButton.click({ timeout: 5_000 });
  } catch (err) {
    log.error(`Could not click "Yes, I applied!" for ${job.company} - NOT marking as applied (${firstLine(err)})`);
    await saveFailureSnapshot(page, job.company);
    return "failed";
  }

  // SAVE_COMPANY - only reached after the confirmation click succeeded.
  const inserted = history.markApplied(job.company);
  log.info(
    inserted
      ? `${job.company} added to applied-company history`
      : `${job.company} was already in history (no duplicate created)`,
  );
  return "applied";
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */

async function runBot(context: BrowserContext, page: Page, history: CompanyHistory): Promise<void> {
  const tabs = new TabManager(context, page);
  log.info(
    `Mode: ${config.dryRun ? "DRY RUN (no clicks)" : "LIVE"} | history has ${history.count()} companies | max applies this run: ${config.maxApplicationsPerRun}`,
  );

  const seen = new Set<string>();
  const stats = { skipped: 0, applied: 0, failed: 0, dryRun: 0, unreadable: 0, noAutofill: 0, reposted: 0 };
  let scrollRounds = 0;

  try {
    outer: while (!stopRequested) {
      tabs.assertJobrightAlive();
      await dismissNagModals(page);
      const cards = await getJobCards(page);
      let newCardsThisPass = 0;

      for (const card of cards) {
        if (stopRequested) break outer;
        if (stats.applied >= config.maxApplicationsPerRun) {
          log.info(`Reached MAX_APPLICATIONS_PER_RUN (${config.maxApplicationsPerRun}) - stopping`);
          break outer;
        }

        // READ_JOB / EXTRACT_COMPANY
        const job = await readJobCard(card);
        if (!job) {
          stats.unreadable++;
          log.error("Company name could not be extracted from job card -> SKIP (no Apply click)");
          continue;
        }
        if (seen.has(job.id)) continue;
        seen.add(job.id);
        newCardsThisPass++;

        const outcome = await processJob(card, job, history, tabs);
        if (outcome === "skipped") stats.skipped++;
        else if (outcome === "applied") stats.applied++;
        else if (outcome === "failed") stats.failed++;
        else if (outcome === "no-autofill") stats.noAutofill++;
        else if (outcome === "reposted") stats.reposted++;
        else stats.dryRun++;

        // Always re-assert the control tab before moving on (AC-08).
        await tabs.returnToJobright();
        await sleep(config.delayBetweenJobs);
      }

      if (newCardsThisPass === 0) {
        if (scrollRounds >= config.maxScrollRounds) {
          log.info("No new jobs after scrolling - done");
          break;
        }
        scrollRounds++;
        log.info(`Scrolling for more jobs (round ${scrollRounds}/${config.maxScrollRounds})`);
        await scrollJobList(page);
      }
    }
  } finally {
    log.info(
      `Summary -> applied: ${stats.applied}, skipped: ${stats.skipped}, would-apply(dry): ${stats.dryRun}, failed: ${stats.failed}, no-autofill: ${stats.noAutofill}, reposted: ${stats.reposted}, unreadable: ${stats.unreadable}`,
    );
    log.info(`External tabs left open: ${tabs.externalTabs.length}`);
    log.info(`Log file: ${log.file}`);
  }
}

/* ------------------------------------------------------------------ */
/* History preparation                                                 */
/* ------------------------------------------------------------------ */

/**
 * Load the local history and merge the resume-builder's applied companies
 * into it. Refuses to run if the remote sync fails, because running on a
 * stale list is exactly how the bot would re-apply to a company already bid
 * on. Pass --offline to run on the local copy anyway.
 */
async function prepareHistory(offline: boolean): Promise<CompanyHistory> {
  const history = new CompanyHistory(config.dbPath);
  if (!config.databaseUrl) {
    log.warn("DATABASE_URL not set - using local history only (no resume-builder sync)");
    return history;
  }
  if (offline) {
    log.warn("--offline: skipping resume-builder sync, using local history as last synced");
    return history;
  }
  try {
    await syncFromResumeBuilder(history, config.databaseUrl, {
      userId: config.remoteUserId,
      timeoutMs: config.remoteSyncTimeout,
    });
  } catch (err) {
    history.close();
    throw new Error(`Resume-builder sync failed - refusing to run on a possibly stale list (${firstLine(err)}). Fix DATABASE_URL or rerun with --offline.`);
  }
  return history;
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = argv.includes("--login")
    ? "login"
    : argv.includes("--inspect")
      ? "inspect"
      : "run";

  // Browser-less utility modes.
  if (argv.includes("--list")) {
    const history = new CompanyHistory(config.dbPath);
    for (const r of history.all()) log.info(`${r.applied_at}  [${r.source}]  ${r.company_name}`);
    log.info(`${history.count()} companies in history`);
    history.close();
    return;
  }
  if (argv.includes("--sync")) {
    const history = await prepareHistory(false);
    history.close();
    return;
  }

  // Sync BEFORE opening the browser so a bad DB never leaves Chrome hanging.
  const history = mode === "run" ? await prepareHistory(argv.includes("--offline")) : null;

  const session = await launchBrowser();
  const { context, page } = session;
  try {
    if (mode === "login") {
      log.info("Log in to Jobright in the browser window. The session is saved to the profile folder.");
      await waitForEnter("Press Enter here when you are logged in and see the job list... ");
      log.info(`Done. Current URL: ${page.url()}`);
      return;
    }

    if (!isLoggedIn(page)) {
      log.error(`Not logged in (URL: ${page.url()}). Run "npm run login" first.`);
      return;
    }
    await page.waitForTimeout(2500); // let the SPA render the list

    if (mode === "inspect") {
      await inspectPage(page);
      return;
    }

    await runBot(context, page, history!);
  } finally {
    history?.close();
    // In profile mode closing kills ALL tabs, including external ones the user
    // may still want to finish. Leave the browser open until confirmed.
    if (mode !== "login") await waitForEnter(session.closeNote);
    await session.close();
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
