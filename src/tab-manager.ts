import type { BrowserContext, Page } from "playwright";
import { log } from "./logger.js";

/**
 * Owns the one rule that must never break: the Jobright tab is the control
 * tab. External tabs opened by "Apply with Autofill" are recorded and left
 * alone; the bot always returns to — and only acts on — the Jobright page.
 */
export class TabManager {
  readonly externalTabs: Page[] = [];

  constructor(
    private readonly context: BrowserContext,
    readonly jobright: Page,
  ) {}

  /**
   * Start watching for a tab that is not Jobright and not already known.
   * Call BEFORE the Apply click so a fast popup is never missed; then poll
   * `watcher.found()` until it returns a page or you give up.
   */
  watchForNewTab(): { found: () => Page | null; stop: () => void } {
    const before = new Set(this.context.pages());
    let found: Page | null = null;
    const onPage = (p: Page) => {
      if (!found && !before.has(p) && p !== this.jobright) found = p;
    };
    this.context.on("page", onPage);
    return {
      found: () => {
        // Belt and braces: also diff pages(), in case the event was missed
        // (e.g. a tab opened by a browser extension).
        if (!found) found = this.context.pages().find((p) => !before.has(p) && p !== this.jobright) ?? null;
        return found;
      },
      stop: () => this.context.off("page", onPage),
    };
  }

  registerExternalTab(p: Page): void {
    this.externalTabs.push(p);
    log.info(`New tab detected (${this.externalTabs.length} external tab(s) open): ${safeUrl(p)}`);
  }

  /** Bring Jobright back to the foreground. No waiting on the external tab. */
  async returnToJobright(): Promise<void> {
    this.assertJobrightAlive();
    await this.jobright.bringToFront();
    log.info("Returning to Jobright");
  }

  /** Guard: anything that touches the DOM must be on the Jobright page. */
  assertJobrightAlive(): void {
    if (this.jobright.isClosed()) {
      throw new Error("Jobright control tab was closed — cannot continue");
    }
  }
}

function safeUrl(p: Page): string {
  try {
    return p.url() || "(loading)";
  } catch {
    return "(unknown)";
  }
}
