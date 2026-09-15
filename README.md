# Jobright Bot

Two implementations of the same bot live in this repo:

| | Where | Runs in |
|---|---|---|
| **Chrome extension** (recommended) | [`extension/`](extension/) | Your own browser (Chrome, Octo, any Chromium) — settings via a UI |
| Node + Playwright bot | [`src/`](src/) | A terminal, driving its own Chrome profile — settings via `.env` |

Both share the same selectors and rules. See **Extension** below, or skip to **Node bot**.

## Extension

### Install (unpacked)
1. Open `chrome://extensions` in the browser where you use Jobright (works in Octo Browser too).
2. Enable **Developer mode** → **Load unpacked** → pick the [`extension/`](extension/) folder.
3. Make sure the **Jobright Autofill** extension is also installed in that profile and you're logged in to Jobright.

### Configure
Click the extension icon → **Settings ⚙**. This page is the extension's `.env`:

- **Run behaviour** — dry run, max applications per run, scroll rounds, delay, what to do with "APPLY NOW" cards.
- **Timeouts** — new tab, confirmation modal, continue/stop when no tab appears.
- **Resume-builder history** — Supabase URL (pre-filled) + API key. Use the **anon** key from Supabase → Project Settings → API; if *Test connection* returns 401/permission denied, use the **service_role** key instead. *Sync now* pulls every company from `applications` + `interviews` into the extension's history; with *Sync before every run* on, that happens automatically.
- **History** — count, add names manually, export JSON.

### Run
Open Jobright's job list and click the icon — the control panel opens in Chrome's **side panel**, which stays open while the bot switches tabs (**↗ window** pops it out as its own window instead). **▶ Start** runs, **■ Stop** ends after the current job. Leave *Dry run* on for the first run, then turn it off with *Max applies* = 2.

During a live run Chrome shows a bar saying *"Jobright Bot started debugging this browser"*. That's expected: Apply is clicked through the DevTools protocol so it counts as a real user gesture (a synthetic click would be stopped by Chrome's popup blocker and no company tab would open). The bar disappears when the run ends. Don't open DevTools on the Jobright tab during a run — only one debugger can attach.

### How it works
- `content.js` runs inside jobright.ai: reads cards, clicks Apply, waits for "Did you apply?", clicks "Yes, I applied!", records the company.
- `background.js` owns the tabs and debugger APIs: sends the real Apply click; while a click is "armed", any new tab is recorded as the external company tab and the Jobright tab is **immediately refocused**. The external tab is never touched.
- `page-bridge.js` runs in the page world and, only while the bot is running, catches a `window.open` that Chrome blocked and hands the URL to the extension to open (inactive) instead.
- `chrome.storage.local` holds settings, history and the log — all private to that browser profile.

## Node bot

Browser automation for Jobright that skips companies you've already applied to,
clicks **Apply with Autofill** for new ones, snaps back to the Jobright tab,
clicks **"Yes, I applied!"**, and records the company. It never touches the
external company tab.

Stack: TypeScript + Playwright + SQLite (better-sqlite3). No n8n, no AI.

## Setup

```powershell
npm install
npx playwright install chromium   # only needed if Google Chrome isn't installed
copy .env.example .env            # then edit as needed
```

## First run: log in once

```powershell
npm run login
```

A Chrome window opens on Jobright using a dedicated profile in `./browser-profile/`.
Log in, wait until the job list shows, then press Enter in the terminal. The session
is saved for every later run.

## Autofill extension (required)

"Apply with Autofill" depends on the **Jobright Autofill** Chrome extension. The
bot uses its own Chrome profile (`./browser-profile/`), so the extension must be
installed *in that profile* once:

1. `npm run login` — the bot's Chrome window opens.
2. In that window, click **"2. Enable Autofill Extension"** on the Jobright page
   (or open the Chrome Web Store and search "Jobright Autofill") and install it.
3. Press Enter in the terminal. The extension is now part of the profile.

Without it Jobright shows an "install extension" prompt instead of opening the
job, and the bot logs `Neither a new tab nor "Did you apply?" appeared`.

## Second run: inspect the DOM

```powershell
npm run inspect
```

Prints which selector candidates match, the first 5 job cards as parsed, and every
visible button. Saves `logs/jobright-snapshot.html` + `.png`. Use this to tune
`src/selectors.ts` until `company=` and `title=` parse correctly.

## Dry run (default)

```powershell
npm start
```

With `DRY_RUN=true` (the default in `.env`) the bot reads jobs, checks the history,
and logs `WOULD CLICK APPLY` — it never clicks Apply.

## Live run

Set `DRY_RUN=false` in `.env`, keep `MAX_APPLICATIONS_PER_RUN=2` for the first few
runs, then `npm start`. Ctrl+C stops after the current job.

## Applied-company history sources

The local SQLite history is the single source the bot checks. It is fed from:

| Source | How |
|---|---|
| `bot` | Every successful "Yes, I applied!" click |
| `resume-builder` | Set `DATABASE_URL` (Supabase Postgres of the resume-builder app). Before every run the bot pulls `DISTINCT company_name` from its `applications` and `interviews` tables (read-only) and merges them in. If the sync fails the bot **refuses to run** — use `npm run offline` to run on the last synced copy. |

`npm run sync` syncs without opening the browser; `npm run list` prints the history.

## Config (`.env`)

| Key | Default | Meaning |
|---|---|---|
| `JOBRIGHT_URL` | `https://jobright.ai/jobs/recommend` | Page opened on start |
| `DRY_RUN` | `true` | Never click Apply |
| `MAX_APPLICATIONS_PER_RUN` | `2` | Safety cap on Apply clicks |
| `MAX_SCROLL_ROUNDS` | `3` | Scroll attempts to load more jobs |
| `NEW_TAB_TIMEOUT` | `15000` | ms to wait for the company tab |
| `CONFIRMATION_TIMEOUT` | `15000` | ms to wait for "Did you apply?" |
| `ON_NEW_TAB_TIMEOUT` | `continue` | `continue` or `stop` when no tab appears |
| `APPLY_NOW_BEHAVIOR` | `skip` | `skip` or `click` for cards labelled "APPLY NOW" (no autofill) |
| `CONFIRM_DELAY_MIN` / `_MAX` | `1500` / `3500` | Random pause before clicking "Yes, I applied!" |
| `DELAY_BETWEEN_JOBS` | `1500` | ms pause between jobs |
| `BROWSER_PROFILE_DIR` | `./browser-profile` | Persistent Chrome profile |
| `DB_PATH` | `./data/jobright.db` | SQLite file |
| `DATABASE_URL` | *(empty)* | Resume-builder Postgres; enables the sync |
| `REMOTE_USER_ID` | *(empty)* | Only pull that user's rows from Postgres |
| `REMOTE_SYNC_TIMEOUT` | `15000` | ms for connect + query |

## Layout

```
src/
  index.ts            entry point, run modes, main loop + per-job state machine
  browser.ts          persistent Chrome profile launch
  jobright.ts         reading cards, apply button, confirmation modal, scrolling, inspect
  tab-manager.ts      Jobright = control tab; detect new tabs; always return
  company-history.ts  SQLite applied-company store + name normalization
  remote-history.ts   read-only sync from the resume-builder Postgres
  selectors.ts        all DOM knowledge (tune here)
  config.ts           .env → typed config
  logger.ts           console + logs/run-*.log
data/jobright.db      created on first run
```

## Rules the code enforces

- A company is saved **only after** "Yes, I applied!" is clicked successfully.
  No tab / no modal / no button → logged, not saved.
- `normalized_name` is `UNIQUE` and inserts use `INSERT OR IGNORE`, so duplicates
  are impossible at the DB level.
- Nag modals ("Maybe later" feedback prompt) are dismissed automatically; the
  "Did you apply?" modal is the only one the bot answers positively.
- On any failed apply, a screenshot and the text of open modals go to `logs/`.
- The new-tab listener is registered *before* the Apply click so a fast popup is
  never missed; the Jobright `Page` reference is held for the whole run and
  `bringToFront()` is called after every job.
