import pg from "pg";
import type { CompanyHistory } from "./company-history.js";
import { log } from "./logger.js";

/**
 * Pull already-applied company names from the resume-builder app's Postgres
 * (tables `applications` and `interviews`) and merge them into the local
 * SQLite history. Read-only: nothing is ever written to the remote DB.
 */
export async function syncFromResumeBuilder(
  history: CompanyHistory,
  databaseUrl: string,
  opts: { userId?: number; timeoutMs: number },
): Promise<number> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }, // Supabase requires TLS
    connectionTimeoutMillis: opts.timeoutMs,
    statement_timeout: opts.timeoutMs,
  });

  const userFilter = opts.userId !== undefined ? "AND user_id = $1" : "";
  const params = opts.userId !== undefined ? [opts.userId] : [];
  const sql = `
    SELECT DISTINCT company_name FROM applications
      WHERE company_name IS NOT NULL AND btrim(company_name) <> '' ${userFilter}
    UNION
    SELECT DISTINCT company_name FROM interviews
      WHERE company_name IS NOT NULL AND btrim(company_name) <> '' ${userFilter}
  `;

  log.info(`Syncing applied companies from resume-builder DB${opts.userId !== undefined ? ` (user_id=${opts.userId})` : ""}...`);
  await client.connect();
  try {
    const res = await client.query<{ company_name: string }>(sql, params);
    const names = res.rows.map((r) => r.company_name);
    const added = history.mergeMany(names, "resume-builder");
    log.info(`Remote sync: ${names.length} companies found, ${added} new, history now has ${history.count()}`);
    return added;
  } finally {
    await client.end().catch(() => {});
  }
}
