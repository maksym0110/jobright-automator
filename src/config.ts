import "dotenv/config";

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return /^(1|true|yes|on)$/i.test(v);
}
function int(v: string | undefined, def: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  jobrightUrl: process.env.JOBRIGHT_URL ?? "https://jobright.ai/jobs/recommend",
  dryRun: bool(process.env.DRY_RUN, true),
  maxApplicationsPerRun: int(process.env.MAX_APPLICATIONS_PER_RUN, 2),
  maxScrollRounds: int(process.env.MAX_SCROLL_ROUNDS, 3),
  newTabTimeout: int(process.env.NEW_TAB_TIMEOUT, 15_000),
  confirmationTimeout: int(process.env.CONFIRMATION_TIMEOUT, 15_000),
  onNewTabTimeout: (process.env.ON_NEW_TAB_TIMEOUT === "stop" ? "stop" : "continue") as
    | "continue"
    | "stop",
  /** "skip" = only click "Apply with Autofill" (spec). "click" = also click "APPLY NOW". */
  applyNowBehavior: (process.env.APPLY_NOW_BEHAVIOR === "click" ? "click" : "skip") as "skip" | "click",
  delayBetweenJobs: int(process.env.DELAY_BETWEEN_JOBS, 1500),
  browserProfileDir: process.env.BROWSER_PROFILE_DIR ?? "./browser-profile",
  dbPath: process.env.DB_PATH ?? "./data/jobright.db",

  /**
   * Resume-builder Postgres (Supabase). When set, its applications/interviews
   * company names are merged into the local history before every run.
   */
  databaseUrl: process.env.DATABASE_URL || undefined,
  /** Optional: only pull rows for this resume-builder user_id. */
  remoteUserId: process.env.REMOTE_USER_ID ? int(process.env.REMOTE_USER_ID, NaN) : undefined,
  remoteSyncTimeout: int(process.env.REMOTE_SYNC_TIMEOUT, 15_000),
} as const;

export type Config = typeof config;
