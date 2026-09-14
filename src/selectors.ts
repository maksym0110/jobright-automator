/**
 * All Jobright DOM knowledge lives here so it can be tuned in one place.
 *
 * Jobright uses CSS-module class names (e.g. "index_job-card__oqX1M"); the
 * hash suffix can change on deploy, so we match on the stable prefix with
 * [class*="index_job-card__"]. Confirmed against a live snapshot (2026-09-13).
 *
 * Run `npm run inspect` to re-verify after a Jobright UI change.
 */
export const selectors = {
  /** One job card. The id attribute is Jobright's job id. */
  jobCard: 'div[id][class*="index_job-card__"]',

  /** Scoped inside a job card. */
  jobTitle: '[class*="index_job-title__"]',
  companyName: '[class*="index_company-name__"]',

  /**
   * The apply button inside each card. Its label is either
   * "Apply with Autofill" or "APPLY NOW" (no autofill support).
   */
  applyButton: 'button[class*="index_apply-button__"]',

  /** ⊘ button on the card; opens a dropdown with "Already Applied". */
  notInterestedButton: 'button[id*="not-interest-button"]',
  alreadyAppliedText: /^already applied$/i,

  /** "4 hours ago" or "Reposted 2 hours ago" tag on the card. */
  publishTime: '[class*="index_publish-time__"]',
  repostedText: /^reposted/i,
  applyWithAutofillText: /apply with autofill/i,
  applyNowText: /^apply now$/i,

  /** Any open Ant Design modal (Jobright's UI kit). */
  modal: ".ant-modal:visible, [role=dialog]:visible",

  /** "Did you apply?" confirmation modal. */
  confirmModalText: /did you apply/i,
  yesAppliedText: /yes,?\s*i applied/i,

  /** Feedback / nag modals to dismiss ("Maybe later", "Not now", "Skip"). */
  dismissTexts: [/^maybe later$/i, /^not now$/i, /^skip$/i, /^later$/i],

  /** Text that indicates Jobright wants the browser extension installed. */
  extensionPromptText: /extension/i,

  /** Scroll container for the job list. */
  jobListScroller: '[class*="jobs-list-scrollable"]',
} as const;
