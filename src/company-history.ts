import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * Normalize a company name for duplicate detection.
 * Deliberately conservative: trim, lowercase, collapse whitespace.
 * Stripping "Inc." / "LLC" etc. can be added once we see real Jobright data.
 */
export function normalizeCompanyName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export type HistorySource = "bot" | "resume-builder";

export interface AppliedCompany {
  id: number;
  company_name: string;
  normalized_name: string;
  applied_at: string;
  source: HistorySource;
}

export class CompanyHistory {
  private db: Database.Database;
  private stmtExists: Database.Statement<[string]>;
  private stmtInsert: Database.Statement<[string, string, string]>;
  private stmtAll: Database.Statement<[]>;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS applied_companies (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        company_name    TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        applied_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        source          TEXT NOT NULL DEFAULT 'bot'
      );
    `);
    // Best-effort upgrade for DBs created before the source column existed.
    try {
      this.db.exec("ALTER TABLE applied_companies ADD COLUMN source TEXT NOT NULL DEFAULT 'bot'");
    } catch {
      /* column already exists */
    }
    this.stmtExists = this.db.prepare(
      "SELECT 1 FROM applied_companies WHERE normalized_name = ? LIMIT 1",
    );
    // INSERT OR IGNORE + UNIQUE index = duplicates can never be created.
    this.stmtInsert = this.db.prepare(
      "INSERT OR IGNORE INTO applied_companies (company_name, normalized_name, source) VALUES (?, ?, ?)",
    );
    this.stmtAll = this.db.prepare(
      "SELECT * FROM applied_companies ORDER BY applied_at DESC",
    );
  }

  hasApplied(companyName: string): boolean {
    return this.stmtExists.get(normalizeCompanyName(companyName)) !== undefined;
  }

  /** Returns true if a new row was inserted, false if it already existed. */
  markApplied(companyName: string, source: HistorySource = "bot"): boolean {
    const normalized = normalizeCompanyName(companyName);
    if (!normalized) return false;
    const result = this.stmtInsert.run(companyName.trim(), normalized, source);
    return result.changes > 0;
  }

  /** Merge many names in one transaction. Returns how many were new. */
  mergeMany(companyNames: Iterable<string>, source: HistorySource): number {
    const run = this.db.transaction((names: Iterable<string>) => {
      let added = 0;
      for (const n of names) if (this.markApplied(n, source)) added++;
      return added;
    });
    return run(companyNames);
  }

  all(): AppliedCompany[] {
    return this.stmtAll.all() as AppliedCompany[];
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM applied_companies").get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
