/**
 * Job-description scraper. Injected into the COMPANY's job page (the tab that
 * "Apply with Autofill" opens), in every frame — ATS providers such as
 * Greenhouse and Lever embed the posting in an iframe, so the best result may
 * come from a child frame. The background worker keeps the longest hit.
 *
 * Returns the last expression, which chrome.scripting.executeScript reports as
 * the frame's result:
 *   { ok: true,  jd, title, company, location, salary, easyApply, url, via, length }
 *   { ok: false, reason, url, length }
 *
 * Deliberately generous: any posting we cannot read is skipped by the caller
 * rather than guessed at, because a wrong JD produces a wrong resume.
 */
(() => {
  const clean = (text) => String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const textOf = (el) => (el ? clean(el.innerText || el.textContent) : '');
  const visible = (el) => Boolean(el) && el.getClientRects().length > 0;

  const MIN_LENGTH = 400;
  const MAX_LENGTH = 12000;

  // Pages that are not a readable posting at all.
  const DEAD_PAGE_RE = /\b(no longer (available|accepting)|position (has been )?(filled|closed)|job (not found|has expired)|this (job|posting) is (closed|no longer))\b/i;
  const LOGIN_WALL_RE = /\b(sign in to (continue|apply|view)|please (log|sign) in|create an account to (apply|continue))\b/i;
  const CAPTCHA_RE = /\b(are you a human|verify you are human|unusual traffic|cloudflare)\b/i;
  const EASY_APPLY_RE = /\beasy\s*apply\b/i;

  // Words a real job description almost always contains.
  const JD_SIGNAL_RE = /\b(responsibilit|requirement|qualification|experience|skills|you will|we are looking|about the role|what you|benefits|salary|preferred)\b/i;

  /* ---------------------------------------------------------------- */
  /* 1. JSON-LD JobPosting — the most reliable source when present     */
  /* ---------------------------------------------------------------- */
  function htmlToText(html) {
    const holder = document.createElement('div');
    holder.innerHTML = String(html || '');
    for (const el of holder.querySelectorAll('script, style')) el.remove();
    for (const el of holder.querySelectorAll('li')) el.insertAdjacentText('afterbegin', '• ');
    for (const el of holder.querySelectorAll('p, div, li, br, h1, h2, h3, h4, tr')) el.insertAdjacentText('afterend', '\n');
    return clean(holder.textContent);
  }

  function flatten(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.flatMap(flatten);
    if (typeof value !== 'object') return [];
    const nested = [...flatten(value['@graph']), ...flatten(value.itemListElement), ...flatten(value.mainEntity)];
    return [value, ...nested];
  }

  function fromJsonLd() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let parsed;
      try {
        parsed = JSON.parse(script.textContent);
      } catch {
        continue;                                  // a broken block must not stop the others
      }
      for (const node of flatten(parsed)) {
        const types = [].concat(node['@type'] || []).map((t) => String(t).toLowerCase());
        if (!types.includes('jobposting')) continue;
        const jd = htmlToText(node.description);
        if (jd.length < MIN_LENGTH) continue;
        const place = [].concat(node.jobLocation || [])[0];
        const address = place && place.address ? place.address : null;
        const pay = node.baseSalary && node.baseSalary.value ? node.baseSalary.value : null;
        const amount = pay ? (pay.value || (pay.minValue && pay.maxValue ? `${pay.minValue}-${pay.maxValue}` : pay.minValue || pay.maxValue)) : '';
        return {
          jd,
          title: clean(node.title),
          company: clean(node.hiringOrganization && node.hiringOrganization.name),
          location: address
            ? clean([address.addressLocality, address.addressRegion, address.addressCountry].filter(Boolean).join(', '))
            : clean(node.jobLocationType === 'TELECOMMUTE' ? 'Remote' : ''),
          salary: amount ? clean(`${pay.currency || ''} ${amount} ${pay.unitText ? `/ ${String(pay.unitText).toLowerCase()}` : ''}`) : '',
          via: 'json-ld'
        };
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* 2. Known containers, per ATS / board                              */
  /* ---------------------------------------------------------------- */
  const JD_SELECTORS = [
    // Greenhouse
    '#content .content', '.job__description', '#app_body', '.job-post-description',
    // Lever
    '.posting-page .section-wrapper', '[data-qa="job-description"]', '.posting-requirements',
    // Ashby
    '[class*="_descriptionText"]', '[class*="ashby-job-posting"]',
    // Workday
    '[data-automation-id="jobPostingDescription"]',
    // SmartRecruiters
    '.job-sections', '.jobad-main', '[itemprop="description"]',
    // Workable / Recruitee / Teamtailor / Personio
    '[data-ui="job-description"]', '.styles__content___2goXk', '.job-description-content', '#job-description',
    // iCIMS / Taleo / Oracle / SuccessFactors
    '.iCIMS_JobContent', '.iCIMS_InfoMsg_Job', '.jobDescription',
    // Jobvite / Breezy / JazzHR / BambooHR
    '.jv-job-detail-description', '.description', '.job-details-content', '#resumator-job-description',
    // LinkedIn / Indeed / Glassdoor / ZipRecruiter / Monster / Dice / Wellfound
    '.jobs-description__content', '.jobs-box__html-content', '.jobs-description-content__text', '.show-more-less-html__markup',
    '#jobDescriptionText', '.jobsearch-jobDescriptionText', '.jobDescriptionContent', '#JobDescriptionContainer',
    '.job_description', '.job-description', '.job-description-wrapper',
    // Generic
    '[class*="job-description" i]', '[class*="jobDescription" i]', '[class*="job_description" i]',
    '[id*="job-description" i]', '[id*="jobDescription" i]', '[data-testid*="job-description" i]',
    '[class*="posting-description" i]', '[class*="vacancy-description" i]', 'article.job', '.job-details'
  ];

  function fromSelectors() {
    let best = null;
    for (const selector of JD_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;                                  // an unsupported selector must not abort the sweep
      }
      for (const el of nodes) {
        const text = textOf(el);
        if (text.length < MIN_LENGTH || text.length > 60000) continue;
        if (!best || text.length > best.jd.length) best = { jd: text, via: `selector ${selector}` };
      }
      if (best && best.jd.length > 1200) break;     // a solid hit; no need to keep sweeping
    }
    return best;
  }

  /* ---------------------------------------------------------------- */
  /* 3. Smallest text block that reads like a posting                  */
  /* ---------------------------------------------------------------- */
  function fromSmallestSignalBlock() {
    const roots = [document.querySelector('main'), document.querySelector('[role="main"]'), document.querySelector('article'), document.body].filter(Boolean);
    let best = null;
    for (const root of roots) {
      const candidates = [root, ...root.querySelectorAll('div, section, td')];
      for (const el of candidates) {
        if (el.querySelectorAll('div, section').length > 400) continue;   // page shell, not a posting
        const text = textOf(el);
        if (text.length < MIN_LENGTH || text.length > 40000) continue;
        if (!JD_SIGNAL_RE.test(text)) continue;
        // Prefer the smallest block that still holds the whole description: the
        // page wrapper always "wins" on raw length but carries nav and footer.
        if (!best || text.length < best.jd.length) best = { jd: text, via: 'text-block' };
      }
      if (best) break;
    }
    return best;
  }

  /* ---------------------------------------------------------------- */
  /* 4. Body text around the first description marker                  */
  /* ---------------------------------------------------------------- */
  const MARKERS = [
    'about the role', 'about this role', 'about the job', 'job description', 'role description',
    'responsibilities', 'what you will do', "what you'll do", 'requirements', 'qualifications',
    'who you are', 'about you', 'the opportunity'
  ];

  function fromBody() {
    const body = textOf(document.body);
    if (body.length < MIN_LENGTH) return null;
    const lower = body.toLowerCase();
    let start = -1;
    for (const marker of MARKERS) {
      const index = lower.indexOf(marker);
      if (index !== -1 && (start === -1 || index < start)) start = index;
    }
    if (start === -1) return null;
    return { jd: clean(body.slice(Math.max(0, start - 300), start + 9000)), via: 'body-markers' };
  }

  /* ---------------------------------------------------------------- */
  /* Page metadata (used when JSON-LD is absent)                       */
  /* ---------------------------------------------------------------- */
  function metaContent(names) {
    for (const name of names) {
      const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
      const value = clean(el && el.getAttribute('content'));
      if (value) return value;
    }
    return '';
  }

  function readTitle() {
    const selectors = [
      '.jobs-unified-top-card__job-title', '.topcard__title', '.jobsearch-JobInfoHeader-title',
      '.posting-headline h2', '.app-title', '[data-automation-id="jobPostingHeader"]',
      '[data-testid="job-title"]', '[class*="job-title" i]', '[class*="jobTitle" i]', 'h1'
    ];
    for (const selector of selectors) {
      const value = textOf(document.querySelector(selector));
      if (value && value.length < 160) return value;
    }
    return clean(metaContent(['og:title']) || document.title).slice(0, 160);
  }

  function readCompany() {
    const selectors = [
      '.jobs-unified-top-card__company-name', '.topcard__org-name-link', '.company-name',
      '[data-testid="company-name"]', '[class*="company-name" i]', '[class*="companyName" i]',
      '.main-header-tagline', '[data-automation-id="jobPostingCompany"]'
    ];
    for (const selector of selectors) {
      const value = textOf(document.querySelector(selector));
      if (value && value.length < 120) return value;
    }
    return metaContent(['og:site_name']).slice(0, 120);
  }

  const SALARY_RE = /(\$\s?\d[\d,.]*\s*[kK]?(?:\s*(?:-|–|—|to)\s*\$?\s?\d[\d,.]*\s*[kK]?)?(?:\s*(?:\/|per\s)?\s*(?:yr|year|annum|hour|hr|mo|month))?)/;

  function readSalary(jd) {
    const match = (jd || '').match(SALARY_RE);
    return match ? clean(match[1]).slice(0, 80) : '';
  }

  /* ---------------------------------------------------------------- */
  /* Result                                                            */
  /* ---------------------------------------------------------------- */
  const url = location.href;
  const bodyText = textOf(document.body);
  const easyApply = EASY_APPLY_RE.test(bodyText.slice(0, 20000)) ||
    [...document.querySelectorAll('button, a, [role="button"]')].some((el) => visible(el) && EASY_APPLY_RE.test(textOf(el)));

  const found = fromJsonLd() || fromSelectors() || fromSmallestSignalBlock() || fromBody();

  if (!found || found.jd.length < MIN_LENGTH) {
    const reason = DEAD_PAGE_RE.test(bodyText) ? 'posting closed'
      : CAPTCHA_RE.test(bodyText) ? 'bot check on the page'
      : LOGIN_WALL_RE.test(bodyText) ? 'sign-in required'
      : bodyText.length < 200 ? 'page did not render'
      : 'no job description found';
    return { ok: false, reason, url, easyApply, length: bodyText.length };
  }

  const jd = found.jd.length > MAX_LENGTH ? `${found.jd.slice(0, MAX_LENGTH)}…` : found.jd;
  return {
    ok: true,
    jd,
    title: found.title || readTitle(),
    company: found.company || readCompany(),
    location: found.location || '',
    salary: found.salary || readSalary(jd),
    easyApply,
    url,
    via: found.via,
    length: jd.length
  };
})();
