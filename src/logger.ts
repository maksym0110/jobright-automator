import fs from "node:fs";
import path from "node:path";

const LOG_DIR = "logs";
fs.mkdirSync(LOG_DIR, { recursive: true });
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = path.join(LOG_DIR, `run-${runStamp}.log`);

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

function write(level: string, msg: string): void {
  const line = `[${ts()}] ${level ? level + " " : ""}${msg}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
  fs.appendFileSync(logFile, line + "\n");
}

export const log = {
  info: (msg: string) => write("", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
  dry: (msg: string) => write("[DRY RUN]", msg),
  file: logFile,
};
