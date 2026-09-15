import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { selectors } from "./selectors.js";
import { log } from "./logger.js";

export type ApplyKind = "autofill" | "apply-now" | "none";

export interface JobInfo {
  id: string; // Jobright job id (card's id attribute)
  title: string;
  company: string;
  applyKind: ApplyKind;
  posted: string; // e.g. "4 hours ago" / "Reposted 2 hours ago"
  reposted: boolean;
}

async function textOf(loc: Locator): Promise<string> {
  const t = await loc.first().textContent({ timeout: 2000 }).catch(() => "");
  return (t ?? "").replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ */
/* Reading the list                                                    */
/* ------------------------------------------------------------------ */

export async function getJobCards(page: Page): Promise<Locator[]> {
  return page.locator(selectors.jobCard).all();
}

export async function readJobCard(card: Locator): Promise<JobInfo | null> {
  const id = (await card.getAttribute("id").catch(() => null)) ?? "";
  const company = await textOf(card.locator(selectors.companyName));
  const title = await textOf(card.locator(selectors.jobTitle));
  if (!company) return null;

  const btnText = await textOf(card.locator(selectors.applyButton));
  const applyKind: ApplyKind = selectors.applyWithAutofillText.test(btnText)
    ? "autofill"
    : selectors.applyNowText.test(btnText)
      ? "apply-now"
      : "none";

  const posted = await textOf(card.locator(selectors.publishTime));
  const reposted = selectors.repostedText.test(posted);
  return { id: id || `${title}|${company}`.toLowerCase(), title: title || "(untitled)", company, applyKind, posted, reposted };
}

/* ------------------------------------------------------------------ */
/* Buttons & modal                                                     */
/* ------------------------------------------------------------------ */

/** The card's own apply button (no detail panel needed). */
export async function findApplyButton(card: Locator): Promise<Locator | null> {
  const btn = card.locator(selectors.applyButton);
  if ((await btn.count()) === 0) return null;
  await card.scrollIntoViewIfNeeded();
  return btn.first();
}

/** ⊘ -> "Already Applied": Jobright moves the card to the Applied list. */
export async function hideAsAlreadyApplied(card: Locator): Promise<boolean> {
  const page = card.page();
  const btn = card.locator(selectors.notInterestedButton);
  if ((await btn.count()) === 0) {
    log.warn("Hide: ⊘ button not found on the card");
    return false;
  }
  await btn.first().scrollIntoViewIfNeeded();
  // antd dropdown trigger: hover opens it; click as a fallback.
  await btn.first().hover();
  const item = page
    .getByRole("menuitem", { name: selectors.alreadyAppliedText })
    .or(page.locator(".ant-dropdown-menu-item", { hasText: selectors.alreadyAppliedText }))
    .first();
  if (!(await item.isVisible().catch(() => false))) await btn.first().click();
  try {
    await item.click({ timeout: 5000 });
  } catch {
    log.warn('Hide: "Already Applied" menu item did not appear');
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
  await page.waitForTimeout(600);
  return true;
}

/** The "Yes, I applied!" button, if currently visible (no waiting). */
export async function findYesAppliedButton(page: Page): Promise<Locator | null> {
  const yes = page
    .getByRole("button", { name: selectors.yesAppliedText })
    .or(page.getByText(selectors.yesAppliedText))
    .first();
  return (await yes.isVisible().catch(() => false)) ? yes : null;
}

/**
 * Close nag modals ("Maybe later" feedback prompt etc.) so they never block
 * a click. Never touches "Did you apply?" — that one is handled explicitly.
 * Returns true if something was dismissed.
 */
export async function dismissNagModals(page: Page): Promise<boolean> {
  let dismissed = false;
  for (const re of selectors.dismissTexts) {
    const btn = page.getByRole("button", { name: re }).or(page.getByText(re)).first();
    if (await btn.isVisible().catch(() => false)) {
      const label = await textOf(btn);
      await btn.click({ timeout: 3000 }).catch(() => {});
      log.info(`Dismissed modal via "${label}"`);
      dismissed = true;
      await page.waitForTimeout(400);
    }
  }
  return dismissed;
}

/** Text of every visible modal/dialog — used for failure diagnostics. */
export async function describeOpenModals(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const m of await page.locator(selectors.modal).all()) {
    const t = await textOf(m);
    if (t) out.push(t.slice(0, 300));
  }
  return out;
}

/** Screenshot + modal dump so a failed apply can be diagnosed after the fact. */
export async function saveFailureSnapshot(page: Page, label: string): Promise<void> {
  fs.mkdirSync("logs", { recursive: true });
  const safe = label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
  const file = path.join("logs", `fail-${safe}-${Date.now()}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  const modals = await describeOpenModals(page);
  log.warn(`Diagnostics: screenshot ${file}; open modals: ${modals.length ? JSON.stringify(modals) : "none"}`);
  if (modals.some((t) => selectors.extensionPromptText.test(t))) {
    log.warn('A modal mentions "extension" - the Jobright Autofill extension is probably not installed in the bot profile. See README "Autofill extension".');
  }
}

/* ------------------------------------------------------------------ */
/* Scrolling                                                           */
/* ------------------------------------------------------------------ */

export async function scrollJobList(page: Page): Promise<void> {
  const scroller = page.locator(selectors.jobListScroller);
  if (await scroller.count()) {
    await scroller
      .first()
      .evaluate((el) => el.scrollBy(0, el.clientHeight * 2))
      .catch(() => {});
  } else {
    await page.mouse.wheel(0, 2000);
  }
  await page.waitForTimeout(1500);
}

/* ------------------------------------------------------------------ */
/* Inspection helper (`npm run inspect`)                               */
/* ------------------------------------------------------------------ */

export async function inspectPage(page: Page): Promise<void> {
  log.info("=== INSPECT: selector match counts ===");
  for (const [name, sel] of Object.entries(selectors)) {
    if (typeof sel !== "string") continue;
    const n = await page.locator(sel).count();
    log.info(`  ${name.padEnd(16)} ${sel.padEnd(40)} -> ${n}`);
  }

  log.info("=== INSPECT: job cards ===");
  const cards = await getJobCards(page);
  for (const card of cards) {
    const info = await readJobCard(card);
    if (!info) {
      log.warn(`  unparseable card: ${(await textOf(card)).slice(0, 120)}`);
      continue;
    }
    log.info(`  [${info.applyKind.padEnd(9)}]${info.reposted ? " [reposted]" : ""} ${info.title} | ${info.company} (${info.id})`);
  }

  log.info("=== INSPECT: visible buttons ===");
  const seen = new Set<string>();
  for (const b of await page.getByRole("button").all()) {
    const t = await textOf(b);
    if (t && !seen.has(t)) {
      seen.add(t);
      log.info(`  [${t}]`);
    }
  }

  fs.mkdirSync("logs", { recursive: true });
  fs.writeFileSync(path.join("logs", "jobright-snapshot.html"), await page.content());
  await page.screenshot({ path: path.join("logs", "jobright-snapshot.png") });
  log.info("Saved logs/jobright-snapshot.html and logs/jobright-snapshot.png");
}
