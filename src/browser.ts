import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";
import { log } from "./logger.js";

/** A connected browser plus the Jobright control tab and a way to close it. */
export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
  /** Prompt shown before closing. */
  closeNote: string;
}

const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
  headless: false,
  viewport: null, // use the real window size
  args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
  // Playwright disables extensions by default. Jobright's "Apply with Autofill"
  // relies on the Jobright Autofill extension, so let profile extensions load.
  ignoreDefaultArgs: ["--disable-extensions"],
};

/**
 * Launch a persistent Chromium profile so the Jobright login (and any
 * installed extension) survives runs. Log in once with `npm run login`.
 */
export async function launchBrowser(): Promise<BrowserSession> {
  log.info(`Launching persistent browser profile: ${config.browserProfileDir}`);
  const context = await chromium
    .launchPersistentContext(config.browserProfileDir, { ...launchOptions, channel: "chrome" })
    .catch(async (err) => {
      log.warn(`Google Chrome unavailable (${(err as Error).message.split("\n")[0]}); using bundled Chromium`);
      return chromium.launchPersistentContext(config.browserProfileDir, launchOptions);
    });
  const page = context.pages()[0] ?? (await context.newPage());
  log.info(`Opening ${config.jobrightUrl}`);
  await page.goto(config.jobrightUrl, { waitUntil: "domcontentloaded" });
  return {
    context,
    page,
    close: () => context.close(),
    closeNote: "Press Enter to close the browser (external tabs will close too)... ",
  };
}

export function isLoggedIn(page: Page): boolean {
  return !/\/(login|signin|sign-in|auth|onboarding)/i.test(page.url());
}
