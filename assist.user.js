// ==UserScript==
// @name         Prolific Assist
// @namespace    https://github.com/fraserreilly
// @version      2.0.1
// @description  API-polling assistant for Prolific: filter, alert, one-click reserve
// @author       fraserreilly
// @license      GNU General Public License v3.0
// @match        *://*.prolific.co/*
// @match        *://*.prolific.com/*
// @grant        none
// @run-at       document-start
// @homepageURL  https://github.com/fraserreilly/prolific-assist
// @supportURL   https://github.com/fraserreilly/prolific-assist/issues
// @downloadURL  https://raw.githubusercontent.com/fraserreilly/prolific-assist/main/assist.user.js
// @updateURL    https://raw.githubusercontent.com/fraserreilly/prolific-assist/main/assist.user.js
// ==/UserScript==
(function () {
  'use strict';

  const CONFIG = {
    accountSince: '2020-01-01', // Prolific join date; only the year is used (set the real one in the Currency tab)
    pollIntervalSec: 30,        // how often to check for new studies (min 15)
    soundVolume: 0.7,           // alert volume, 0-1
    rateProvider: 'HMRC',       // FX source for earnings: 'HMRC' | 'ECB' | 'PayPal'
  };

  let activeSettings = null;                                          // live settings, for browser-only helpers
  let apiAuth = null, apiProlificId = null, apiClientVersion = null;  // auth headers captured from the app's own API calls
  let apiUserId = null;                                              // participant id from a /users/<id>/ path (authoritative for the balance URL)
  let pollNextAt = 0, pollIntervalMs = 0;                             // next-poll timing, for the panel's countdown + progress bar

  // ---- pure (Node-testable) ----
  function defaultSettings() {
    return {
      minHourly: null,
      minTotal: null,
      includeKeywords: [],
      excludeKeywords: [],
      requirements: { camera: 'ignore', microphone: 'ignore', audio: 'ignore', install: 'ignore' },
      pollIntervalSec: CONFIG.pollIntervalSec,
      soundVolume: CONFIG.soundVolume,
      rateProvider: CONFIG.rateProvider,
      rateOverrides: {}, // per-year rate edits: { HMRC: { USD: { 2026: 0.75 } }, ... }
      accountSince: CONFIG.accountSince,
    };
  }

  function parseKeywords(str) {
    return String(str || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  // Pull the participant id out of an internal-api URL path (…/users/<id>/…), used to
  // build the balance endpoint. Returns the id or null. Anchored to the /users/ segment
  // so query strings and other path parts can't be mistaken for an id.
  function parseUserId(url) {
    const m = String(url || '').match(/\/users\/([0-9a-fA-F-]{20,40})(?:[/?#]|$)/);
    return m ? m[1] : null;
  }

  function matcher(study, s) {
    if (s.minHourly != null && study.hourlyRate < s.minHourly) return false;
    if (s.minTotal != null && study.totalPay < s.minTotal) return false;
    const title = String(study.title || '').toLowerCase();
    if (s.includeKeywords.length &&
        !s.includeKeywords.some((k) => title.includes(k.toLowerCase()))) return false;
    if (s.excludeKeywords.some((k) => title.includes(k.toLowerCase()))) return false;
    for (const key of Object.keys(s.requirements)) {
      const mode = s.requirements[key];
      const has = !!(study.requirements && study.requirements[key]);
      if (mode === 'require' && !has) return false;
      if (mode === 'hide' && has) return false;
    }
    return true;
  }

  function normalizeStudy(raw) {
    const peripherals = (raw.peripheral_requirements || []).map((p) => String(p).toLowerCase());
    const hasAny = (words) => peripherals.some((p) => words.some((w) => p.includes(w)));
    return {
      id: raw.id,
      title: raw.name,
      totalPay: raw.reward / 100,
      hourlyRate: raw.estimated_reward_per_hour / 100,
      durationMin: raw.estimated_completion_time,
      placesLeft: raw.total_available_places - raw.places_taken,
      requirements: {
        camera: hasAny(['camera', 'webcam']),
        microphone: hasAny(['microphone', 'mic']),
        audio: hasAny(['audio', 'speaker', 'headphone']),
        install: hasAny(['download', 'install', 'software']),
      },
      bonus: parseBonus(raw.description),
    };
  }

  // Best-effort promised-bonus phrase from a study description (free text, so a
  // labelled guess, never counted in hard totals). Returns a short label or null.
  function parseBonus(description) {
    const text = String(description || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ');
    if (!/bonus/i.test(text)) return null;
    let m = text.match(/up to\s*([£$€])\s?(\d+(?:\.\d{1,2})?)/i);
    if (m) return 'up to ' + m[1] + m[2] + ' bonus';
    m = text.match(/\b1[\s-]*in[\s-]*(\d+)\b/i);
    if (m) return '1 in ' + m[1] + ' bonus';
    m = text.match(/([£$€])\s?(\d+(?:\.\d{1,2})?)\s*(?:\S+\s+){0,3}bonus/i);
    if (m) return m[1] + m[2] + ' bonus';
    m = text.match(/bonus[^.£$€]{0,20}([£$€])\s?(\d+(?:\.\d{1,2})?)/i);
    if (m) return m[1] + m[2] + ' bonus';
    m = text.match(/(\d+)\s?%/);
    if (m) return m[1] + '% bonus';
    return 'bonus available';
  }

  // APPROVED (paid/available) and AWAITING REVIEW (pending) count toward earnings,
  // plus any submission that paid a screened-out fee (real money, whatever the exact
  // status string is). RETURNED/REJECTED/TIMED OUT and in-progress do not.
  const EARNING_STATUSES = new Set(['APPROVED', 'AWAITING REVIEW']);
  function sumAmounts(arr) { return (arr || []).reduce((t, x) => t + (Number(x && x.amount) || 0), 0); }

  function normalizeSubmission(raw) {
    const study = raw.study || {};
    const reward = raw.submission_reward || {};
    return {
      id: raw.id,
      studyId: study.id,
      studyName: study.name || '',
      status: raw.status,
      startedAt: raw.started_at ? Date.parse(raw.started_at) : null,
      completedAt: raw.completed_at ? Date.parse(raw.completed_at) : null,
      timeTakenSec: Number(raw.time_taken) || 0,
      currency: reward.currency || 'GBP',
      rewardMinor: Number(reward.amount) || 0,
      bonusMinor: sumAmounts(raw.submission_bonuses),
      extrasMinor: sumAmounts(raw.submission_adjustments) + sumAmounts(raw.screened_out_payments),
      countsToEarnings: EARNING_STATUSES.has(raw.status) || sumAmounts(raw.screened_out_payments) > 0,
    };
  }

  // USD->GBP by year, per provider. HMRC = official tax-year averages, ECB =
  // mid-market, PayPal = ECB minus a ~3.4% spread calibrated from a real withdrawal.
  // Pre-2023 HMRC reuses ECB (published service starts 2023); 2026 HMRC clamps to 2025.
  // Edit/extend any of these in the Currency tab; edits persist as overrides.
  const RATE_PROVIDERS = {
    HMRC:   { USD: { 2020: 0.7796, 2021: 0.7270, 2022: 0.8119, 2023: 0.8044, 2024: 0.7820, 2025: 0.7601 } },
    ECB:    { USD: { 2020: 0.7796, 2021: 0.7270, 2022: 0.8119, 2023: 0.8047, 2024: 0.7823, 2025: 0.7593, 2026: 0.7438 } },
    PayPal: { USD: { 2020: 0.753, 2021: 0.702, 2022: 0.784, 2023: 0.777, 2024: 0.756, 2025: 0.733, 2026: 0.719 } },
  };
  const PROVIDER_NAMES = Object.keys(RATE_PROVIDERS);
  const DEFAULT_PROVIDER = 'HMRC';
  // Earliest year any provider has a rate for (fallback lower bound for the editor).
  const RATE_YEARS_FROM = Math.min(...PROVIDER_NAMES.flatMap((p) => Object.keys(RATE_PROVIDERS[p].USD).map(Number)));

  // A provider's currency table with any per-year user overrides layered on top.
  // Shape: { USD: { 2024: 0.78, ... } }. fx.table is one of these.
  function providerTable(provider, overrides) {
    const base = (RATE_PROVIDERS[provider] || RATE_PROVIDERS[DEFAULT_PROVIDER]).USD || {};
    const ov = (overrides && overrides[provider] && overrides[provider].USD) || {};
    return { USD: { ...base, ...ov } };
  }

  // Multiplier to GBP for `currency` earned at `dateMs` (ms, optional), using the
  // year-of-earning rate from fx.table. A year not in the table clamps to the nearest
  // year present; dateless (the all-time lump) uses the latest year. Home currency,
  // or any currency with no table, is 1:1.
  function rateFor(currency, dateMs, fx) {
    if (!fx || currency === fx.home) return 1;
    const t = fx.table && fx.table[currency];
    if (!t) return 1;
    const years = Object.keys(t).map(Number);
    if (!years.length) return 1;
    const target = dateMs != null ? new Date(dateMs).getFullYear() : Math.max(...years);
    const year = t[target] != null ? target : years.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    return t[year];
  }
  function toGBPminor(minor, currency, fx, dateMs) {
    if (!fx) return minor;
    return Math.round(minor * rateFor(currency, dateMs, fx));
  }
  function submissionGBPminor(sub, fx) {
    const dateMs = sub.completedAt != null ? sub.completedAt : sub.startedAt;
    return toGBPminor(sub.rewardMinor + sub.bonusMinor + sub.extrasMinor, sub.currency, fx, dateMs);
  }

  // All-time GBP total: sum Prolific's per-currency lifetime totals
  // (meta.total_earned_by_currency), each converted at the latest-year rate since the
  // lump is dateless. Falls back to meta.total_earned only if the breakdown is missing.
  function allTimeGBPminor(totalByCurrency, totalEarnedMinor, fx) {
    if (totalByCurrency && totalByCurrency.length) {
      return totalByCurrency.reduce((t, c) => t + toGBPminor(Number(c.amount) || 0, c.currency, fx), 0);
    }
    return Number(totalEarnedMinor) || 0;
  }

  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function startOfWeek(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
  function startOfMonth(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); }
  function startOfYear(ms) { const d = new Date(ms); return new Date(d.getFullYear(), 0, 1).getTime(); }
  // UK tax year runs 6 April -> 5 April.
  function startOfTaxYear(ms) { const d = new Date(ms); const y = d.getFullYear(); const apr6 = new Date(y, 3, 6).getTime(); return ms >= apr6 ? apr6 : new Date(y - 1, 3, 6).getTime(); }

  // Sums earnings (GBP minor) per period, counting only paid/pending submissions
  // (both currencies, converted via fx). today's £/hr uses ONLY time actually
  // worked (time_taken), so idle time never dilutes it; null when no worked time.
  function earningsSummary(subs, fx, nowMs) {
    const dayStart = startOfDay(nowMs), weekStart = startOfWeek(nowMs), monthStart = startOfMonth(nowMs);
    const yearStart = startOfYear(nowMs), taxStart = startOfTaxYear(nowMs);
    let today = 0, week = 0, month = 0, year = 0, tax = 0, todaySec = 0;
    for (const s of subs) {
      if (!s.countsToEarnings) continue;
      const t = s.completedAt != null ? s.completedAt : s.startedAt;
      if (t == null) continue;
      const g = submissionGBPminor(s, fx);
      if (t >= taxStart) tax += g;
      if (t >= yearStart) year += g;
      if (t >= monthStart) month += g;
      if (t >= weekStart) week += g;
      if (t >= dayStart) { today += g; todaySec += s.timeTakenSec; }
    }
    return {
      todayMinor: today, weekMinor: week, monthMinor: month, yearMinor: year, taxYearMinor: tax,
      todayWorkedSec: todaySec, todayRateMinorPerHr: todaySec > 0 ? (today / (todaySec / 3600)) : null,
    };
  }

  const SETTINGS_KEY = 'prolificAssist:settings';

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      return raw ? { ...defaultSettings(), ...raw,
        requirements: { ...defaultSettings().requirements, ...(raw.requirements || {}) } } : defaultSettings();
    } catch { return defaultSettings(); }
  }
  function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

  // ---- browser UI ----

  const CHEV = '<svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 4.5l4 4 4-4"/></svg>';

  const PANEL_HTML = `
    <section class="panel" aria-label="Prolific Assist">
      <header class="panel-head" id="pa-head">
        <span class="dot live" id="pa-live" data-kind="warn" title="Watching"></span>
        <h1>Prolific Assist</h1>
        <span class="ver" id="pa-ver">30s</span>
        <span class="mute-wrap">
          <button class="iconbtn" id="pa-mute" type="button" title="Mute alerts">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8H3.5S6 15 6 9M10 21a2 2 0 0 0 4 0"/></svg>
          </button>
          <div class="mutemenu" id="pa-mutemenu">
            <button type="button" data-min="15">Mute 15 min</button>
            <button type="button" data-min="60">Mute 1 hour</button>
            <button type="button" data-min="240">Mute 4 hours</button>
            <button type="button" data-min="-1">Mute until I turn it on</button>
            <button type="button" data-min="0">Unmute</button>
          </div>
        </span>
        <span class="align-wrap">
          <button class="iconbtn" id="pa-align" type="button" title="Align - pick a corner">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="4" height="4" rx="1"/><rect x="6" y="1" width="4" height="4" rx="1"/><rect x="11" y="1" width="4" height="4" rx="1"/><rect x="1" y="6" width="4" height="4" rx="1"/><rect x="11" y="6" width="4" height="4" rx="1"/><rect x="1" y="11" width="4" height="4" rx="1"/><rect x="6" y="11" width="4" height="4" rx="1"/><rect x="11" y="11" width="4" height="4" rx="1"/></svg>
          </button>
          <div class="align-pop">
            <div class="agrid">
              <button class="acell" data-a="tl" type="button"></button><button class="acell" data-a="tc" type="button"></button><button class="acell pref" data-a="tr" type="button"></button>
              <button class="acell" data-a="ml" type="button"></button><button class="acell" data-a="c" type="button"></button><button class="acell" data-a="mr" type="button"></button>
              <button class="acell" data-a="bl" type="button"></button><button class="acell" data-a="bc" type="button"></button><button class="acell" data-a="br" type="button"></button>
            </div>
            <div class="cap">click a spot to pin there and make it default</div>
          </div>
        </span>
        <button class="iconbtn" id="pa-collapse" type="button" title="Collapse / expand" aria-label="Collapse or expand panel">${CHEV}</button>
      </header>
      <div class="pa-prog" id="pa-prog"><i></i></div>

      <div class="matches">
        <div class="mlabel">Matches <span class="mcount" id="pa-mcount">0</span>
          <select class="msort" id="pa-sort" title="Sort matches">
            <option value="newest">Newest</option>
            <option value="rate">£/hr</option>
            <option value="total">Total pay</option>
            <option value="mins">Shortest</option>
            <option value="left">Fewest left</option>
          </select>
        </div>
        <div class="mlist" id="pa-mlist"></div>
        <button class="showmore" id="pa-showmore" type="button" hidden>Show more</button>
        <div class="m-empty" id="pa-empty" style="padding:2px 14px 12px;color:var(--ink-soft);font-size:12px">Watching - matches will appear here.</div>
      </div>

      <div class="pa-settings" id="pa-settings">
        <div class="tabs">
          <button class="tab on" data-tab="filters" type="button">Filters</button>
          <button class="tab" data-tab="earnings" type="button">Earnings</button>
          <button class="tab" data-tab="currency" type="button">Currency</button>
        </div>

        <div class="tabpanel on" data-tab="filters">
          <section class="group" data-section="pay">
            <button class="ghead" type="button"><span>Pay</span>${CHEV}</button>
            <div class="gbody">
              <div class="row">
                <span class="grow">Min hourly rate</span>
                <span class="field pay"><span class="unit">£</span><input id="pa-hourly" inputmode="decimal"><span class="unit">/hr</span></span>
              </div>
              <div class="row">
                <span class="grow">Min total pay</span>
                <span class="field pay"><span class="unit">£</span><input id="pa-total" inputmode="decimal"></span>
              </div>
              <div class="row sub">Leave a field blank to ignore it.</div>
            </div>
          </section>

          <section class="group" data-section="requirements">
            <button class="ghead" type="button"><span>Requirements</span>${CHEV}</button>
            <div class="gbody">
              <div class="reqicons">
                <button class="reqicon" data-req="camera" type="button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3"/></svg></button>
                <button class="reqicon" data-req="microphone" type="button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
                <button class="reqicon" data-req="audio" type="button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9v6h4l5 4V5L8 9H4zM17 9a4 4 0 0 1 0 6"/></svg></button>
                <button class="reqicon" data-req="install" type="button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v11m0 0l-4-4m4 4l4-4M4 19h16"/></svg></button>
              </div>
              <div class="row sub">Click to cycle: <b class="k-ign">ignore</b> / <b class="k-req">require</b> / <b class="k-hide">hide</b></div>
            </div>
          </section>

          <section class="group" data-section="keywords">
            <button class="ghead" type="button"><span>Keywords</span>${CHEV}</button>
            <div class="gbody">
              <div class="row sub">Only match if title contains</div>
              <span class="field"><input class="tl" id="pa-include" placeholder="any word, comma-separated"></span>
              <div class="row sub">Skip if title contains</div>
              <span class="field"><input class="tl" id="pa-exclude" placeholder="none"></span>
            </div>
          </section>

          <section class="group" data-section="timing">
            <button class="ghead" type="button"><span>Timing and sound</span>${CHEV}</button>
            <div class="gbody">
              <div class="row">
                <span class="grow">Check every</span>
                <span class="field"><input id="pa-interval" inputmode="numeric"><span class="unit">sec</span></span>
              </div>
              <div class="row">
                <span class="grow">Alert volume</span>
                <span class="field"><input id="pa-volume" inputmode="numeric"><span class="unit">%</span></span>
              </div>
            </div>
          </section>

        </div>

        <div class="tabpanel" data-tab="earnings">
          <div class="erows">
            <div class="erow"><span>Available</span><b id="pa-e-available">-</b></div>
            <div class="erow"><span>Pending</span><b id="pa-e-pending">-</b></div>
            <div class="erow big"><span id="pa-e-today-lbl">Today</span><b id="pa-e-today">-</b></div>
            <div class="erow"><span>This week</span><b id="pa-e-week">-</b></div>
            <div class="erow"><span>This month</span><b id="pa-e-month">-</b></div>
            <div class="erow yearrow">
              <button class="yearsel" id="pa-yearsel" type="button">Year <span id="pa-e-year-lbl">-</span><svg class="chev" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 4.5l4 4 4-4"/></svg></button>
              <b id="pa-e-year">-</b>
              <div class="yearmenu" id="pa-yearmenu"></div>
            </div>
            <div class="erow taxrow">
              <button class="taxsel" id="pa-taxsel" type="button">Tax year <span id="pa-e-taxyear-lbl">-</span><svg class="chev" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 4.5l4 4 4-4"/></svg></button>
              <b id="pa-e-taxyear">-</b>
              <div class="taxmenu" id="pa-taxmenu"></div>
            </div>
            <div class="allowance" id="pa-allowance"></div>
            <div class="erow"><span>All-time</span><b id="pa-e-alltime">-</b></div>
            <div class="exportbar">
              <button class="btn ghost" id="pa-export" type="button">Export CSV</button>
              <button class="btn ghost expchev" id="pa-export-menu-btn" type="button" title="Export a period">
                <svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 4.5l4 4 4-4"/></svg>
              </button>
              <div class="export-menu" id="pa-export-menu">
                <button class="emitem" type="button" data-period="today">Today</button>
                <button class="emitem" type="button" data-period="week">This week</button>
                <button class="emitem" type="button" data-period="month">This month</button>
                <div class="emrow"><button class="emitem" type="button" data-period="year">Year</button><select class="emsel" id="pa-exp-year" title="Choose year"></select></div>
                <div class="emrow"><button class="emitem" type="button" data-period="taxyear">Tax year</button><select class="emsel" id="pa-exp-taxyear" title="Choose tax year"></select></div>
                <button class="emitem" type="button" data-period="all">All-time</button>
                <div class="emcustom">
                  <div class="sub">Custom range</div>
                  <div class="emdates"><input type="date" id="pa-export-from" title="From"><input type="date" id="pa-export-to" title="To"></div>
                  <button class="btn ghost wide" id="pa-export-custom" type="button">Export range</button>
                </div>
              </div>
            </div>
            <div class="sub" style="line-height:1.5">Export runs only when you click it. Converted at Prolific's rate; per-hour counts only time actually spent in studies.</div>
          </div>
        </div>

        <div class="tabpanel" data-tab="currency">
          <div class="provsel" role="group" aria-label="Rate source to edit">
            <button class="prov" type="button" data-prov="HMRC">HMRC</button>
            <button class="prov" type="button" data-prov="ECB">ECB</button>
            <button class="prov" type="button" data-prov="PayPal">PayPal</button>
          </div>
          <div class="provnote"></div>
          <div class="ratehead"><span class="grow">Earning since</span><input type="date" id="pa-accountsince" class="dtin"></div>
          <div class="ratebox" id="pa-rate-editor"></div>
          <div class="sub" style="padding:2px 14px 13px">1 USD in &pound; for the selected source. Set &ldquo;Earning since&rdquo; to your first year on Prolific to trim the list. Edits override the built-in value and save to this browser.</div>
        </div>
      </div>

      <footer class="foot" id="pa-footer" data-kind="ok"><span id="pa-foot-main">Starting...</span><span class="foot-stats" id="pa-foot-stats"></span></footer>
    </section>
  `;

  // Scoped under #pa-root so it can never leak onto Prolific's own page.
  const PANEL_CSS = `
    #pa-root {
      --bg: #eef1f6; --panel: #ffffff; --ink: #1a2230; --ink-soft: #5b6675;
      --line: #e2e6ee; --field: #f5f7fb; --field-line: #d5dbe6;
      --accent: #1f6f8b; --accent-ink: #ffffff;
      --go: #1f8a5b; --go-soft: #e7f4ee; --hide: #b0433a; --hide-soft: #f7e7e5;
      --warn: #b7791f; --warn-soft: #fbf3e2;
      --shadow: 0 10px 30px -12px rgba(20,30,50,.35), 0 2px 6px -2px rgba(20,30,50,.15);
      --radius: 12px;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
      position: fixed; top: 16px; right: 16px; z-index: 2147483000;
      font-family: var(--sans);
    }
    @media (prefers-color-scheme: dark) {
      #pa-root {
        --bg: #0f141c; --panel: #171e28; --ink: #e7ecf3; --ink-soft: #97a2b2;
        --line: #263040; --field: #10161f; --field-line: #2c3745;
        --accent: #3fa7c4; --accent-ink: #06171d;
        --go: #46c489; --go-soft: #12271e; --hide: #e0736a; --hide-soft: #2c1512;
        --warn: #e0a94a; --warn-soft: #2a2110;
        --shadow: 0 12px 34px -12px rgba(0,0,0,.6), 0 2px 6px -2px rgba(0,0,0,.5);
      }
    }
    #pa-root[data-theme="dark"] {
      --bg: #0f141c; --panel: #171e28; --ink: #e7ecf3; --ink-soft: #97a2b2;
      --line: #263040; --field: #10161f; --field-line: #2c3745;
      --accent: #3fa7c4; --accent-ink: #06171d;
      --go: #46c489; --go-soft: #12271e; --hide: #e0736a; --hide-soft: #2c1512;
      --warn: #e0a94a; --warn-soft: #2a2110;
      --shadow: 0 12px 34px -12px rgba(0,0,0,.6), 0 2px 6px -2px rgba(0,0,0,.5);
    }
    #pa-root[data-theme="light"] {
      --bg: #eef1f6; --panel: #ffffff; --ink: #1a2230; --ink-soft: #5b6675;
      --line: #e2e6ee; --field: #f5f7fb; --field-line: #d5dbe6;
      --accent: #1f6f8b; --accent-ink: #ffffff;
      --go: #1f8a5b; --go-soft: #e7f4ee; --hide: #b0433a; --hide-soft: #f7e7e5;
      --warn: #b7791f; --warn-soft: #fbf3e2;
      --shadow: 0 10px 30px -12px rgba(20,30,50,.35), 0 2px 6px -2px rgba(20,30,50,.15);
    }

    #pa-root, #pa-root * { box-sizing: border-box; }
    #pa-root [hidden] { display: none !important; }
    #pa-root svg { display: block; }
    /* Host pages (Prolific) ship global rules like button:not(:first-child){margin-left}
       that cascade into our injected buttons (we're in the page DOM, not a shadow root) and
       indent every list item except the first. We never set margins on these, so zero them. */
    #pa-root .mutemenu button, #pa-root .taxmenu button, #pa-root .yearmenu button, #pa-root .emitem, #pa-root .acell { margin: 0 !important; }

    #pa-root .panel { position: relative; width: 308px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
    #pa-root .panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px; border-bottom: 1px solid var(--line); cursor: move; user-select: none; touch-action: none; }
    #pa-root .panel-head h1 { font-size: 13.5px; font-weight: 650; margin: 0; color: var(--ink); }
    #pa-root .ver { margin-left: auto; font: 11px/1 var(--mono); color: var(--ink-soft); }
    #pa-root .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--go); flex: none; }
    #pa-root .dot.live { --live: var(--go); background: var(--live); animation: pa-pulse 2.8s ease-out infinite; }
    #pa-root .dot.live[data-kind="warn"] { --live: var(--warn); }
    @keyframes pa-pulse {
      0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--live) 55%, transparent); }
      70%  { box-shadow: 0 0 0 7px color-mix(in srgb, var(--live) 0%, transparent); }
      100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--live) 0%, transparent); }
    }
    #pa-root .iconbtn { background: none; border: 0; padding: 4px; cursor: pointer; color: var(--ink-soft); border-radius: 6px; display: grid; place-items: center; }
    #pa-root .iconbtn:hover { background: var(--field); color: var(--ink); }
    #pa-root .chev { transition: transform .15s; }
    #pa-root:not(.collapsed) #pa-collapse .chev { transform: rotate(180deg); }
    #pa-root .pa-prog { height: 2px; background: var(--line); overflow: hidden; }
    #pa-root .pa-prog i { display: block; height: 100%; width: 0%; background: var(--accent); transition: width .25s linear; }

    #pa-root .align-wrap { position: relative; display: inline-flex; }
    #pa-root .align-pop { position: absolute; top: 100%; right: 0; margin-top: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); padding: 8px; display: none; z-index: 6; }
    #pa-root .align-pop.open { display: block; }
    #pa-root .agrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
    #pa-root .acell { width: 24px; height: 17px; border: 1px solid var(--field-line); border-radius: 4px; background: var(--field); cursor: pointer; padding: 0; position: relative; }
    #pa-root .acell:hover { border-color: var(--accent); }
    #pa-root .acell::after { content: ""; position: absolute; width: 5px; height: 5px; border-radius: 1px; background: var(--ink-soft); }
    #pa-root .acell[data-a^="t"]::after { top: 2px; }
    #pa-root .acell[data-a^="b"]::after { bottom: 2px; }
    #pa-root .acell[data-a="ml"]::after, #pa-root .acell[data-a="c"]::after, #pa-root .acell[data-a="mr"]::after { top: 50%; transform: translateY(-50%); }
    #pa-root .acell[data-a$="l"]::after { left: 2px; }
    #pa-root .acell[data-a$="r"]::after { right: 2px; }
    #pa-root .acell[data-a="tc"]::after, #pa-root .acell[data-a="c"]::after, #pa-root .acell[data-a="bc"]::after { left: 50%; margin-left: -2.5px; }
    #pa-root .acell.pref { background: var(--accent); border-color: var(--accent); }
    #pa-root .acell.pref::after { background: #fff; }
    #pa-root .align-pop .cap { font-size: 10px; color: var(--ink-soft); text-align: center; margin-top: 6px; max-width: 96px; }

    #pa-root .mute-wrap { position: relative; display: inline-flex; }
    #pa-root #pa-mute { position: relative; }
    #pa-root #pa-mute.muted { color: var(--hide); }
    #pa-root #pa-mute.muted::after { content: ""; position: absolute; left: 4px; right: 4px; top: 50%; height: 2px; margin-top: -1px; background: var(--hide); transform: rotate(-45deg); border-radius: 2px; }
    #pa-root .mutemenu { position: absolute; top: 100%; right: 0; margin-top: 6px; min-width: 156px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); padding: 5px; display: none; z-index: 7; }
    #pa-root .mutemenu.open { display: block; }
    #pa-root .mutemenu button { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--ink); font: 500 12px/1 var(--sans); padding: 8px 9px; border-radius: 7px; cursor: pointer; }
    #pa-root .mutemenu button:hover { background: var(--field); }

    #pa-root .matches { border-bottom: 1px solid var(--line); }
    #pa-root .mlabel { font: 700 10.5px/1 var(--sans); letter-spacing: .09em; text-transform: uppercase; color: var(--ink-soft); padding: 11px 12px 6px 14px; display: flex; gap: 7px; align-items: center; }
    #pa-root .mcount { background: var(--go-soft); color: var(--go); border-radius: 999px; padding: 1px 7px; font-size: 10px; font-weight: 700; }
    #pa-root .msort { margin-left: auto; font: 600 10px/1 var(--sans); color: var(--ink-soft); background: var(--field); border: 1px solid var(--field-line); border-radius: 6px; padding: 4px 6px; cursor: pointer; }
    #pa-root .mlist { max-height: 236px; overflow-y: auto; padding: 0 12px 4px; display: grid; gap: 8px; }
    #pa-root .mcard { background: var(--field); border: 1px solid var(--field-line); border-left: 3px solid var(--go); border-radius: 9px; padding: 9px 10px; display: grid; gap: 7px; }
    #pa-root:not(.showall) .mcard:nth-child(n+5) { display: none; }
    #pa-root .m-top { display: flex; gap: 6px; align-items: flex-start; }
    #pa-root .m-title { font-size: 12.5px; font-weight: 600; color: var(--ink); line-height: 1.3; flex: 1; }
    #pa-root .m-title a { color: inherit; text-decoration: none; }
    #pa-root .m-title a:hover { color: var(--accent); text-decoration: underline; }
    #pa-root .m-reqs, #pa-root .m-top .reqs { display: inline-flex; gap: 4px; color: var(--ink-soft); flex: none; }
    #pa-root .m-meta { display: flex; gap: 5px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
    #pa-root .m-acts { display: flex; gap: 6px; }
    #pa-root .showmore { margin: 10px 12px 12px; width: calc(100% - 24px); background: transparent; border: 1px dashed var(--field-line); color: var(--ink-soft); border-radius: 8px; padding: 8px; cursor: pointer; font: 600 11.5px/1 var(--sans); }
    #pa-root .chip { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: var(--panel); border: 1px solid var(--field-line); color: var(--ink-soft); }
    #pa-root .chip.rate { background: var(--go-soft); border-color: transparent; color: var(--go); font-weight: 650; }
    #pa-root .chip.warn { background: var(--warn-soft); border-color: transparent; color: var(--warn); font-weight: 650; }
    #pa-root .chip.bonus { background: color-mix(in srgb, var(--accent) 14%, transparent); border-color: transparent; color: var(--accent); font-weight: 650; }
    #pa-root .btn { font: 600 12px/1 var(--sans); border: 0; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
    #pa-root .btn.go { background: var(--go); color: #fff; flex: 1; }
    #pa-root .btn.ghost { background: transparent; color: var(--ink-soft); border: 1px solid var(--field-line); }
    #pa-root .btn.ghost:disabled { cursor: not-allowed; opacity: .6; }
    #pa-root .btn.wide { width: 100%; }

    #pa-root.collapsed .pa-settings { display: none; }
    #pa-root .tabs { display: flex; gap: 4px; padding: 8px 12px 0; border-bottom: 1px solid var(--line); }
    #pa-root .tab { flex: 1; padding: 8px; border: 0; background: none; cursor: pointer; font: 700 10.5px/1 var(--sans); letter-spacing: .07em; text-transform: uppercase; color: var(--ink-soft); border-radius: 8px 8px 0 0; margin-bottom: -1px; }
    #pa-root .tab.on { color: var(--ink); box-shadow: inset 0 -2px 0 var(--accent); }
    #pa-root .tabpanel { display: none; }
    #pa-root .tabpanel.on { display: block; }

    #pa-root .group { border-bottom: 1px solid var(--line); }
    #pa-root .group:last-child { border-bottom: 0; }
    #pa-root .ghead { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 11px 14px; background: none; border: 0; cursor: pointer; font: 700 10.5px/1 var(--sans); letter-spacing: .09em; text-transform: uppercase; color: var(--ink-soft); }
    #pa-root .ghead:hover { color: var(--ink); }
    #pa-root .ghead .chev { transition: transform .15s; color: var(--ink-soft); }
    #pa-root .group.open .ghead .chev { transform: rotate(180deg); }
    #pa-root .gbody { padding: 0 14px 13px; display: grid; gap: 11px; position: relative; }
    #pa-root .group:not(.open) .gbody { display: none; }

    #pa-root .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    #pa-root .grow { flex: 1; font-size: 13px; color: var(--ink); }
    #pa-root .sub { font-size: 11.5px; color: var(--ink-soft); }
    #pa-root .sub b { font-weight: 700; }
    #pa-root .k-ign { color: var(--ink-soft); font-weight: 700; }
    #pa-root .k-req { color: var(--accent); font-weight: 700; }
    #pa-root .k-hide { color: var(--hide); font-weight: 700; }

    #pa-root .field { display: flex; align-items: center; gap: 4px; background: var(--field); border: 1px solid var(--field-line); border-radius: 8px; padding: 5px 9px; min-width: 92px; }
    #pa-root .field .unit { font-size: 12px; color: var(--ink-soft); }
    #pa-root .field input { border: 0; background: transparent; color: var(--ink); width: 100%; font: 600 13px/1 var(--sans); font-variant-numeric: tabular-nums; outline: none; text-align: right; }
    #pa-root .field input.tl { text-align: left; font-weight: 500; }
    #pa-root .field.pay { min-width: 0; width: 104px; }
    #pa-root .field.pay input { text-align: left; width: 3.4em; flex: none; }
    #pa-root .field:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }

    #pa-root .reqicons { display: flex; gap: 8px; }
    #pa-root .reqicon { position: relative; width: 40px; height: 40px; display: grid; place-items: center; border-radius: 10px; border: 1px solid var(--field-line); background: var(--field); color: var(--ink-soft); cursor: pointer; transition: background .12s, border-color .12s, color .12s; }
    #pa-root .reqicon:hover { border-color: var(--ink-soft); color: var(--ink); }
    #pa-root .reqicon.st-require { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
    #pa-root .reqicon.st-hide { background: var(--hide-soft); border-color: var(--hide); color: var(--hide); }
    #pa-root .reqicon.st-hide::after { content: ""; position: absolute; left: 7px; right: 7px; top: 50%; height: 2px; margin-top: -1px; background: var(--hide); transform: rotate(-45deg); border-radius: 2px; }

    #pa-root .erows { padding: 12px 14px; display: grid; gap: 9px; }
    #pa-root .erow { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 12.5px; }
    #pa-root .erow > span { color: var(--ink-soft); }
    #pa-root .erow b { color: var(--ink); font-variant-numeric: tabular-nums; font-weight: 650; }
    #pa-root .erow b small { color: var(--ink-soft); font-weight: 500; }
    #pa-root .erow.big span small { font-size: 11px; color: var(--go); font-weight: 500; margin-left: 5px; }

    #pa-root .provsel { display: flex; margin: 12px 14px 0; border: 1px solid var(--field-line); border-radius: 8px; overflow: hidden; }
    #pa-root .prov { flex: 1; padding: 7px 4px; border: 0; border-left: 1px solid var(--field-line); background: var(--field); color: var(--ink-soft); cursor: pointer; font: 700 11px/1 var(--sans); }
    #pa-root .prov:first-child { border-left: 0; }
    #pa-root .prov:hover { color: var(--ink); }
    #pa-root .prov.on { background: var(--accent); color: var(--accent-ink); }
    #pa-root .prov.on, #pa-root .prov.on + .prov { border-left-color: transparent; } /* let the fill reach the segment edge */
    #pa-root .provnote { padding: 7px 14px 0; font-size: 11px; color: var(--ink-soft); }
    #pa-root .ratebox { padding: 11px 14px 2px; display: grid; gap: 9px; max-height: 216px; overflow-y: auto; }
    #pa-root .ratehead { display: flex; align-items: center; gap: 10px; padding: 12px 14px 0; }
    #pa-root .dtin { background: var(--field); border: 1px solid var(--field-line); border-radius: 8px; padding: 5px 8px; color: var(--ink); font: 600 12px/1 var(--sans); color-scheme: light dark; }
    #pa-root .dtin:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
    #pa-root .allowance { font-size: 11px; color: var(--ink-soft); }
    #pa-root .allowance.near { color: var(--warn); font-weight: 650; }
    #pa-root .allowance.over { color: var(--hide); font-weight: 700; }
    #pa-root .taxrow, #pa-root .yearrow { position: relative; }
    #pa-root .taxsel, #pa-root .yearsel { display: inline-flex; align-items: center; gap: 4px; background: none; border: 0; padding: 0; color: var(--ink-soft); font: inherit; cursor: pointer; }
    #pa-root .taxsel:hover, #pa-root .yearsel:hover { color: var(--ink); }
    #pa-root .taxsel .chev, #pa-root .yearsel .chev { color: var(--ink-soft); }
    #pa-root .taxmenu, #pa-root .yearmenu { position: absolute; top: 100%; left: 0; margin-top: 4px; min-width: 118px; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; box-shadow: var(--shadow); padding: 5px; display: none; z-index: 6; }
    #pa-root .taxmenu.open, #pa-root .yearmenu.open { display: block; }
    #pa-root .taxmenu button, #pa-root .yearmenu button { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--ink); font: 500 12px/1 var(--sans); font-variant-numeric: tabular-nums; padding: 7px 9px; border-radius: 6px; cursor: pointer; }
    #pa-root .taxmenu button:hover, #pa-root .taxmenu button.sel,
    #pa-root .yearmenu button:hover, #pa-root .yearmenu button.sel { background: var(--field); }

    #pa-root .foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--field); border-top: 1px solid var(--line); font-size: 12px; color: var(--ink); font-variant-numeric: tabular-nums; font-weight: 600; }
    #pa-root .foot small { color: var(--go); }
    #pa-root .foot[data-kind="warn"] { color: var(--warn); font-weight: 500; }
    #pa-root #pa-foot-main { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    #pa-root .foot-stats { margin-left: auto; flex: none; color: var(--ink-soft); font-weight: 500; font-size: 11px; white-space: nowrap; }

    /* inline in the label's spare space (never a sibling of the field), so it can't shift it */
    #pa-root .saved-inline { margin-left: 6px; font-size: 10.5px; font-weight: 500; color: var(--ink-soft); opacity: 0; transition: opacity .15s; white-space: nowrap; }
    #pa-root .saved-inline.show { opacity: 1; }
    #pa-root .btn:disabled { opacity: .5; cursor: default; }
    #pa-root .exportbar { display: flex; gap: 6px; position: relative; }
    #pa-root .exportbar #pa-export { flex: 1; }
    #pa-root .expchev { flex: none; width: 34px; padding: 8px 6px; display: grid; place-items: center; }
    #pa-root .export-menu { position: absolute; bottom: 100%; right: 0; margin-bottom: 6px; min-width: 168px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); padding: 6px; display: none; z-index: 6; overflow: hidden; }
    #pa-root .export-menu.open { display: block; }
    #pa-root .emitem { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--ink); font: 500 12px/1 var(--sans); padding: 8px 9px; border-radius: 7px; cursor: pointer; }
    #pa-root .emitem:hover { background: var(--field); }
    #pa-root .emrow { display: flex; align-items: center; gap: 6px; }
    #pa-root .emrow .emitem { flex: 1; }
    #pa-root .emsel { flex: none; max-width: 96px; background: var(--field); border: 1px solid var(--field-line); border-radius: 6px; color: var(--ink); font: 600 11px/1 var(--sans); font-variant-numeric: tabular-nums; padding: 5px 4px; cursor: pointer; }
    #pa-root .btn .spin { display: inline-block; width: 11px; height: 11px; margin-right: 7px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; vertical-align: -1px; animation: pa-spin .7s linear infinite; }
    @keyframes pa-spin { to { transform: rotate(360deg); } }
    #pa-root .emcustom { border-top: 1px solid var(--line); margin-top: 5px; padding-top: 8px; display: grid; gap: 6px; }
    #pa-root .emdates { display: flex; gap: 5px; }
    #pa-root .emdates input { flex: 1; min-width: 0; background: var(--field); border: 1px solid var(--field-line); border-radius: 7px; padding: 5px 6px; color: var(--ink); font: 500 11px/1 var(--sans); }
  `;

  function injectStyles(wrap) {
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    wrap.prepend(style);
    return wrap;
  }

  // Panel UI state (collapsed, drag position, per-section open) persists
  // separately from settings so it survives reloads without polluting filters.
  const UI_KEY = 'prolificAssist:ui';
  function loadUi() {
    const defaults = { collapsed: false, pos: null, sections: {}, tab: 'filters', sort: 'newest', align: null, mutedUntil: 0 };
    try { return { ...defaults, ...(JSON.parse(localStorage.getItem(UI_KEY)) || {}) }; }
    catch { return defaults; }
  }
  function saveUi(ui) { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch {} }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  // Bottom edge of Prolific's fixed top nav bar, so top-anchored positions sit
  // below it rather than under it. Best-effort; 0 if none detected.
  function topInset() {
    let b = 0;
    try {
      document.querySelectorAll('header, nav, [role="banner"]').forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || cs.position === 'sticky') {
          const r = el.getBoundingClientRect();
          if (r.top <= 2 && r.height > 8 && r.height < 160 && r.width > window.innerWidth * 0.5) b = Math.max(b, r.bottom);
        }
      });
    } catch {}
    return b;
  }

  const REQ_STATES = ['ignore', 'require', 'hide'];
  const REQ_STATE_CLASS = { ignore: 'st-ignore', require: 'st-require', hide: 'st-hide' };

  // Pick where the inline "saved" text attaches: the changed control's label
  // (the row's .grow or nearest .sub caption), which has spare room, so it never
  // nudges the field the way a sibling flex item would.
  function savedHost(el) {
    const row = el.closest('.row');
    if (row && row.querySelector('.grow')) return row.querySelector('.grow');
    const gbody = el.closest('.gbody');
    if (gbody) {
      let before = null, after = null;
      gbody.querySelectorAll('.sub').forEach((sub) => {
        const rel = el.compareDocumentPosition(sub);
        if (rel & Node.DOCUMENT_POSITION_PRECEDING) before = sub;
        else if ((rel & Node.DOCUMENT_POSITION_FOLLOWING) && !after) after = sub;
      });
      return before || after || gbody;
    }
    return el.parentElement;
  }
  function flashSaved(el) {
    const host = savedHost(el);
    if (!host) return;
    let s = host.querySelector(':scope > .saved-inline');
    if (!s) { s = document.createElement('span'); s.className = 'saved-inline'; s.textContent = 'saved'; host.appendChild(s); }
    s.classList.add('show');
    clearTimeout(s._t);
    s._t = setTimeout(() => s.classList.remove('show'), 1200);
  }

  function buildPanel(settings, onChange) {
    const ui = loadUi();
    const wrap = document.createElement('div');
    wrap.id = 'pa-root';
    wrap.innerHTML = PANEL_HTML;
    (document.body || document.documentElement).appendChild(injectStyles(wrap));

    const byId = (id) => wrap.querySelector('#' + id);

    // ---- position: either a drag-pinned corner (ui.pos) or an align preset (ui.align) ----
    const applyPos = () => {
      const p = ui.pos;
      if (!p) return; // default: CSS top-right
      const w = wrap.offsetWidth || 308, h = wrap.offsetHeight || 60;
      wrap.style.left = wrap.style.right = wrap.style.top = wrap.style.bottom = 'auto';
      if (p.h === 'right') wrap.style.right = clamp(p.hOff, 0, window.innerWidth - w) + 'px';
      else wrap.style.left = clamp(p.hOff, 0, window.innerWidth - w) + 'px';
      if (p.v === 'bottom') wrap.style.bottom = clamp(p.vOff, 0, window.innerHeight - h) + 'px';
      else wrap.style.top = clamp(p.vOff, 0, window.innerHeight - h) + 'px';
    };
    // Snap the panel to one of the 9 screen anchors (corners, edges, centre).
    const anchor = (name) => {
      const w = wrap.offsetWidth || 308, h = wrap.offsetHeight || 60, m = 16;
      const W = window.innerWidth, H = window.innerHeight;
      const ti = topInset();
      const xs = { l: m, c: (W - w) / 2, r: W - w - m }, ys = { t: ti > 0 ? ti + 8 : m, m: (H - h) / 2, b: H - h - m };
      const map = { tl: ['l', 't'], tc: ['c', 't'], tr: ['r', 't'], ml: ['l', 'm'], c: ['c', 'm'], mr: ['r', 'm'], bl: ['l', 'b'], bc: ['c', 'b'], br: ['r', 'b'] };
      const [xk, yk] = map[name] || map.tr;
      wrap.style.left = clamp(xs[xk], 0, W - w) + 'px';
      wrap.style.top = clamp(ys[yk], 0, H - h) + 'px';
      wrap.style.right = wrap.style.bottom = 'auto';
    };
    const applyPosition = () => { if (ui.align) anchor(ui.align); else applyPos(); };
    applyPosition();
    window.addEventListener('resize', applyPosition);

    // collapse: hides the Filters/Earnings tabs only - matches + header stay visible
    const applyCollapsed = () => wrap.classList.toggle('collapsed', !!ui.collapsed);
    applyCollapsed();
    byId('pa-collapse').addEventListener('click', (e) => {
      e.stopPropagation();
      ui.collapsed = !ui.collapsed; applyCollapsed(); saveUi(ui);
    });

    // drag by the header (ignores clicks on buttons, the align popover, and the live dot)
    const head = byId('pa-head');
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || e.target.closest('.align-pop') || e.target.id === 'pa-live') return;
      const r = wrap.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { head.setPointerCapture(e.pointerId); } catch {}
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const w = wrap.offsetWidth, h = wrap.offsetHeight, m = 8;
      const x = clamp(e.clientX - drag.dx, m, window.innerWidth - w - m);
      const y = clamp(e.clientY - drag.dy, m, window.innerHeight - h - m);
      wrap.style.left = x + 'px'; wrap.style.top = y + 'px'; wrap.style.right = 'auto'; wrap.style.bottom = 'auto';
    });
    const endDrag = () => {
      if (!drag) return; drag = null;
      const r = wrap.getBoundingClientRect();
      const w = wrap.offsetWidth, h = wrap.offsetHeight;
      // pin to whichever corner it ended up nearest, so it stays put across reloads and window resizes
      const hEdge = (r.left + w / 2) > window.innerWidth / 2 ? 'right' : 'left';
      const vEdge = (r.top + h / 2) > window.innerHeight / 2 ? 'bottom' : 'top';
      ui.pos = {
        h: hEdge, hOff: hEdge === 'right' ? Math.max(0, window.innerWidth - r.right) : Math.max(0, r.left),
        v: vEdge, vOff: vEdge === 'bottom' ? Math.max(0, window.innerHeight - r.bottom) : Math.max(0, r.top),
      };
      ui.align = null; // a manual drag takes over from any align preset
      saveUi(ui); applyPos();
    };
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);

    // align picker: click the icon to OPEN the grid (click-toggle, so it can't
    // vanish mid-hover); click a cell to snap + set preferred + persist + close.
    const alignPop = wrap.querySelector('.align-pop');
    wrap.querySelectorAll('.acell').forEach((c) => c.classList.toggle('pref', c.dataset.a === (ui.align || 'tr')));
    byId('pa-align').addEventListener('click', (e) => { e.stopPropagation(); alignPop.classList.toggle('open'); });
    wrap.querySelectorAll('.acell').forEach((c) => c.addEventListener('click', () => {
      ui.align = c.dataset.a;
      wrap.querySelectorAll('.acell').forEach((x) => x.classList.toggle('pref', x === c));
      saveUi(ui); anchor(ui.align); alignPop.classList.remove('open');
    }));
    document.addEventListener('click', (e) => { if (!e.target.closest('.align-wrap')) alignPop.classList.remove('open'); });

    // mute menu: silence alerts now, for a set time, or until turned back on
    const muteMenu = byId('pa-mutemenu');
    const paintMute = () => {
      const mu = loadUi().mutedUntil || 0;
      const on = mu === -1 || (mu > 0 && Date.now() < mu);
      byId('pa-mute').classList.toggle('muted', on);
      byId('pa-mute').title = !on ? 'Mute alerts'
        : (mu === -1 ? 'Alerts muted - click to change' : 'Muted until ' + new Date(mu).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    };
    paintMute();
    byId('pa-mute').addEventListener('click', (e) => { e.stopPropagation(); muteMenu.classList.toggle('open'); });
    muteMenu.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const min = Number(b.dataset.min);
      ui.mutedUntil = min === 0 ? 0 : (min === -1 ? -1 : Date.now() + min * 60000);
      saveUi(ui); muteMenu.classList.remove('open'); paintMute();
    }));
    document.addEventListener('click', (e) => { if (!e.target.closest('.mute-wrap')) muteMenu.classList.remove('open'); });

    // tabs: Filters / Earnings / Currency
    wrap.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === ui.tab));
    wrap.querySelectorAll('.tabpanel').forEach((p) => p.classList.toggle('on', p.dataset.tab === ui.tab));
    wrap.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
      ui.tab = t.dataset.tab;
      wrap.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
      wrap.querySelectorAll('.tabpanel').forEach((p) => p.classList.toggle('on', p.dataset.tab === t.dataset.tab));
      saveUi(ui);
      if (ui.tab === 'earnings') refreshEarnings();
    }));

    // collapsible filter sections (collapsed by default; state remembered)
    wrap.querySelectorAll('.group[data-section]').forEach((sec) => {
      const key = sec.dataset.section;
      sec.classList.toggle('open', !!ui.sections[key]);
      sec.querySelector('.ghead').addEventListener('click', () => {
        const now = !sec.classList.contains('open');
        sec.classList.toggle('open', now);
        ui.sections[key] = now; saveUi(ui);
      });
    });

    // fields ('' -> null so blank means "ignore")
    const num = (v) => (v.trim() === '' ? null : Number(v));
    byId('pa-hourly').value = settings.minHourly ?? '';
    byId('pa-total').value = settings.minTotal ?? '';
    byId('pa-include').value = settings.includeKeywords.join(', ');
    byId('pa-exclude').value = settings.excludeKeywords.join(', ');
    byId('pa-interval').value = settings.pollIntervalSec;
    byId('pa-volume').value = Math.round(settings.soundVolume * 100);

    // live countdown + progress bar to the next poll (JS-driven, so it still
    // works with OS "reduce motion" turned on)
    const prog = byId('pa-prog').firstElementChild;
    const updatePollUi = () => {
      updateStats();            // keep footer seen/accepted current (also across tabs)
      paintMute();              // reflect a timed mute expiring
      if (!pollIntervalMs) return;
      const remainMs = Math.max(0, pollNextAt - Date.now());
      byId('pa-ver').textContent = Math.ceil(remainMs / 1000) + 's';
      prog.style.width = (100 * (1 - remainMs / pollIntervalMs)) + '%';
    };
    updatePollUi();
    setInterval(updatePollUi, 250);

    const commit = (changedEl) => {
      settings.minHourly = num(byId('pa-hourly').value);
      settings.minTotal = num(byId('pa-total').value);
      settings.includeKeywords = parseKeywords(byId('pa-include').value);
      settings.excludeKeywords = parseKeywords(byId('pa-exclude').value);
      settings.pollIntervalSec = Math.max(15, Number(byId('pa-interval').value) || 30);
      settings.soundVolume = Math.min(1, Math.max(0, Number(byId('pa-volume').value) / 100 || 0));
      saveSettings(settings);
      onChange(settings);
      if (changedEl) flashSaved(changedEl);
    };
    wrap.querySelectorAll('input:not(#pa-accountsince)').forEach((el) => el.addEventListener('change', () => commit(el)));

    // requirement icons cycle ignore -> require -> hide, restyling per state
    wrap.querySelectorAll('.reqicon[data-req]').forEach((btn) => {
      const req = btn.dataset.req;
      const paint = () => {
        const state = settings.requirements[req] || 'ignore';
        btn.classList.remove('st-ignore', 'st-require', 'st-hide');
        btn.classList.add(REQ_STATE_CLASS[state]);
        btn.title = cap(req) + ': ' + state + ' - click to change';
        btn.setAttribute('aria-label', btn.title);
      };
      paint();
      btn.addEventListener('click', () => {
        const cur = settings.requirements[req] || 'ignore';
        settings.requirements[req] = REQ_STATES[(REQ_STATES.indexOf(cur) + 1) % REQ_STATES.length];
        paint(); saveSettings(settings); onChange(settings); flashSaved(btn);
      });
    });

    byId('pa-sort').value = ui.sort;
    byId('pa-sort').addEventListener('change', (e) => {
      ui.sort = e.target.value; saveUi(ui); renderMatches();
    });

    // rate provider (settings.rateProvider): shared by the Earnings toggle and the
    // Currency editor. Switching repaints earnings from cache, no re-poll.
    const PROV_NOTE = {
      HMRC: 'Official HMRC yearly averages - your tax basis.',
      ECB: 'ECB mid-market yearly averages.',
      PayPal: 'What actually lands, after PayPal\'s hidden conversion cut.',
    };
    // First year the editor shows: the "Earning since" year (clamped sane), the same
    // for every provider so switching source never changes the rows.
    const startYear = () => {
      const now = new Date().getFullYear();
      const y = new Date(settings.accountSince || CONFIG.accountSince).getFullYear();
      return Number.isFinite(y) ? Math.min(Math.max(y, 2000), now) : RATE_YEARS_FROM;
    };
    const renderRateEditor = () => {
      const host = byId('pa-rate-editor'); if (!host) return;
      const p = settings.rateProvider || DEFAULT_PROVIDER;
      const fx = { home: 'GBP', table: providerTable(p, settings.rateOverrides) };
      let html = '';
      for (let y = startYear(); y <= new Date().getFullYear(); y++) {
        const val = rateFor('USD', new Date(y, 6, 1).getTime(), fx); // built-in / override, else nearest year
        html += `<div class="row"><span class="grow">${p} ${y}</span>` +
          `<span class="field pay"><span class="unit">£</span><input class="rate-in" data-year="${y}" inputmode="decimal" value="${val}"></span></div>`;
      }
      host.innerHTML = html;
      host.querySelectorAll('.rate-in').forEach((inp) => inp.addEventListener('change', () => {
        const y = inp.dataset.year, v = Number(inp.value);
        if (!Number.isFinite(v) || v <= 0) { renderRateEditor(); return; } // reject junk, restore
        settings.rateOverrides = settings.rateOverrides || {};
        settings.rateOverrides[p] = settings.rateOverrides[p] || { USD: {} };
        settings.rateOverrides[p].USD = settings.rateOverrides[p].USD || {};
        settings.rateOverrides[p].USD[y] = v;
        saveSettings(settings); paintEarnings(); flashSaved(inp);
      }));
    };
    const asInput = byId('pa-accountsince');
    if (asInput) {
      asInput.value = String(settings.accountSince || CONFIG.accountSince).slice(0, 10); // date part (migrates old datetime values)
      asInput.addEventListener('change', () => {
        settings.accountSince = asInput.value || CONFIG.accountSince;
        saveSettings(settings); renderRateEditor(); flashSaved(asInput);
      });
    }
    const paintProv = () => {
      const p = settings.rateProvider || DEFAULT_PROVIDER;
      wrap.querySelectorAll('.prov').forEach((b) => b.classList.toggle('on', b.dataset.prov === p));
      wrap.querySelectorAll('.provnote').forEach((n) => { n.textContent = PROV_NOTE[p] || ''; });
    };
    wrap.querySelectorAll('.prov').forEach((b) => b.addEventListener('click', () => {
      settings.rateProvider = b.dataset.prov;
      saveSettings(settings); paintProv(); renderRateEditor(); paintEarnings();
    }));
    paintProv();
    renderRateEditor();

    // show more / fewer (first 4 matches are always visible; CSS hides the rest unless .showall)
    byId('pa-showmore').addEventListener('click', () => {
      wrap.classList.toggle('showall');
      updateShowMoreUI();
    });

    // export earnings CSV: main button exports the last-used period; the chevron
    // opens a menu of presets, per-year pickers, and a custom From/To range. On-demand.
    const exportMenu = byId('pa-export-menu');
    const expYearSel = byId('pa-exp-year');
    const expTaxSel = byId('pa-exp-taxyear');
    expYearSel.innerHTML = yearStarts(Date.now(), 6).map((s) => `<option value="${s}">${yearLabel(s)}</option>`).join('');
    expTaxSel.innerHTML = taxYearStarts(Date.now(), 6).map((s) => `<option value="${s}">${taxYearLabel(s)}</option>`).join('');
    // Year / Tax year read their own picker in the menu; other periods use the presets.
    const boundsFor = (period) => {
      if (period === 'year') {
        const start = Number(expYearSel.value) || startOfYear(Date.now());
        return [start, yearEndMs(start), 'year-' + yearLabel(start)];
      }
      if (period === 'taxyear') {
        const start = Number(expTaxSel.value) || startOfTaxYear(Date.now());
        return [start, taxYearEndMs(start), 'taxyear-' + taxYearLabel(start).replace('/', '-')];
      }
      return exportBounds(period);
    };
    [expYearSel, expTaxSel].forEach((sel) => sel.addEventListener('click', (e) => e.stopPropagation())); // don't close the menu
    byId('pa-export').addEventListener('click', () => exportRange(...boundsFor(ui.exportPeriod || 'all')));
    byId('pa-export-menu-btn').addEventListener('click', (e) => { e.stopPropagation(); exportMenu.classList.toggle('open'); });
    wrap.querySelectorAll('.emitem').forEach((it) => it.addEventListener('click', () => {
      ui.exportPeriod = it.dataset.period; saveUi(ui);
      exportMenu.classList.remove('open');
      exportRange(...boundsFor(ui.exportPeriod));
    }));
    byId('pa-export-custom').addEventListener('click', () => {
      const fromV = byId('pa-export-from').value, toV = byId('pa-export-to').value;
      const from = fromV ? new Date(fromV + 'T00:00:00').getTime() : -Infinity;
      const to = toV ? new Date(toV + 'T23:59:59').getTime() : Infinity;
      exportMenu.classList.remove('open');
      exportRange(from, to, 'custom');
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.exportbar')) exportMenu.classList.remove('open'); });

    // selectable Year / Tax-year rows: a chevron dropdown of recent years; picking one
    // fills that row on demand (the current year stays driven by the live refresh).
    const wirePeriodSel = (menuId, selId, lblId, starts, labelOf, curStart, setSel, showPast, rowSel) => {
      const menu = byId(menuId);
      setSel(curStart);
      const lbl0 = byId(lblId); if (lbl0) lbl0.textContent = labelOf(curStart);
      menu.innerHTML = starts.map((s) => `<button type="button" class="${s === curStart ? 'sel' : ''}" data-start="${s}">${labelOf(s)}</button>`).join('');
      byId(selId).addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
      menu.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        menu.classList.remove('open');
        menu.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
        const start = Number(b.dataset.start);
        setSel(start);
        const lbl = byId(lblId); if (lbl) lbl.textContent = labelOf(start);
        if (start === curStart) { if (lastEarnings) paintEarnings(); else refreshEarnings(); } // current: repaint, no refetch
        else showPast(start);                       // past: cached fetch (reused on reselect)
      }));
      document.addEventListener('click', (e) => { if (!e.target.closest(rowSel)) menu.classList.remove('open'); });
    };
    wirePeriodSel('pa-taxmenu', 'pa-taxsel', 'pa-e-taxyear-lbl', taxYearStarts(Date.now(), 6), taxYearLabel, startOfTaxYear(Date.now()), (s) => { selectedTaxYearStart = s; }, showTaxYear, '.taxrow');
    wirePeriodSel('pa-yearmenu', 'pa-yearsel', 'pa-e-year-lbl', yearStarts(Date.now(), 6), yearLabel, startOfYear(Date.now()), (s) => { selectedYearStart = s; }, showYear, '.yearrow');

    renderMatches();
  }

  // ---- dedupe (per-study, capped at the last 500 seen ids) ----
  const SEEN_KEY = 'prolificAssist:seen';
  function seenSet() { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY)) || []); } catch { return new Set(); } }
  function isSeen(id) { return seenSet().has(id); }
  function markSeen(id) { const s = seenSet(); s.add(id); localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-500))); }

  // ---- footer stats: matching studies surfaced today (seen) vs studies started
  // today (accepted). Seen is a shared, per-day counter; accepted comes from the
  // earnings fetch. ----
  const STATS_KEY = 'prolificAssist:seenStats';
  function bumpSeenToday() {
    const today = new Date().toDateString();
    let s = readStore(STATS_KEY);
    if (!s || s.date !== today) s = { date: today, count: 0 };
    s.count++;
    try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch {}
  }
  function seenTodayCount() {
    const s = readStore(STATS_KEY);
    return (s && s.date === new Date().toDateString()) ? s.count : 0;
  }
  function updateStats() {
    const el = document.getElementById('pa-foot-stats');
    if (el) el.textContent = acceptedTodayCount + ' accepted';
  }

  // ---- notifier: alert sound + toasts ----
  // https://notificationsounds.com/notification-sounds/plucky-564
  const ALERT_SOUND_DATA_URI = 'data:audio/mp3;base64,//uQxAAA1DH+8QMM1srWQN9AYyW5EECgAGiDIcnvLTaMBwtPWjGh6QsEACDk9MQwgn4cW7k8/ocw76CCQAUQX9AwNyhPBg52CyaeuwIMjP/2j4eT3sQQgmTtoc8mTQfuTJk6IE7PTMh/F0QIEI8Z/BAhhO//9YECJTiIhDNZyGH1D34soAIXZNOyBAgAAAEECCBPTCBAhh5ND+9MiCwAqzydEEM/u2iIz97u/dwCEIfTEHIBEMpNt+DjDSQwMwXZaOpHJyWTc2jSzDzcRCo6KbwrQgyMRjcg8giKekysysGuY5C4sQWtgrywzbTFHon5I0Q0JV0dQUc2RzghPlly2wxzaKsOo+jZQtl9hzW97pNIZlDGIvOsQagN01aNlz5G4agaouVYYok8DGTTbYMNJwEEJ4cmSmCqcld2SUeSJoGiyIpBxU7JV0jKKeMIYMmBG8VQYivLDlVDNX3Lli7ZATIFS+MNMnUk/GLU2qRI+u4PYzp688cvK7lsDcwNNJmm1ShkkOP6hVUIceO1Y5orJkqydnp80C/hNOqKTuuksrEK//uSxBqDVdIK/AYZOcvDwWDKs4ABBDLTCkSBTm6shuLMI5aJpHbKkhBZPJOJHjueYiQ3Eb15gcVrIsrTCpKwkyk7yYo0wjBCGCy9KslIJo7h07dXFVrJ4tGq4YDPdJmFPRx1JBt1zSQ6dGs9OTgkjRG/HVUk0zHyG/Vuys3yTIj+JLcugjNnUTsWdivQQUpBrDLKVr9ZmZjwjy/XDf+JRTsOSiy5cHReGJyX2Ksrt8uSmFtIXY8iyy8YrkFfcefgNgbT77gOPcqUksikOUMvjGMrlcN0z+Q5Tyikx+phyrnzdS7T3IYkFeWb/K9ndp7lvOn3lU/dPdtWc6ljVWX0mOcsztv5FMLWFTl/PWsNdr08bzx1zuHKl6nmIx+OEovTeUYvW87ljKxT5YV7F2X36C7vtb95SikpOSivSXfr5UlXlexXt1safDC9LL34clcr7G5ZLKSkwllinyv1bfK28NV+TdO/+VjGb7unlExjrDmu4W99+X1uYY53qlJVn9Zq/G4bAQMQQBAQDDglA/aQwELNjXIXqYcpeEAzBOjnEk9n9v/7ksQRABqFdVe5rIAC5DmoX7dAArWCo+PIwLnGJ2SOWCzRjgke7t7ldMczgGtNcZ5H2gyWQ5dnyoCy1TgGDRCWT8cfuUTlFbUADE1EAoCqk+0fvZfhSY27ei1bLkUVpP0v+m3jKe485n/eddVTVRIvgZjhM6r/m9N8FybNnPXOZ//9wnpTEZRkw5bkD3Na+rzfO//MN//97+Mkj7xzHYAemNRbP8cf/9Zf///////////2JbF9Zf9XLeVkcBgbOuXDv/////YCAAAAF203YEArOUuW7tYcpMxQ1+Fb1bWWJvGIjRkeEfZugds4BuxQYmLIzIm8bBbKKK0zE8fH0H5DLKIsO4yKI5pVRMTgN5xYTWTp9I+kgkZFY2dkWdSRt6a0EUbqWkbblEZUQhIiGDQNwoAz4YUsRKipKOWTp763/7sk19SRea9JT2o60zxPJOknIuI5MUWQRQRdne6N6yaJ0zLjFtnL+X0ydMbIM6JtNTy7IIn1JmTrNf//867/9NWBEAAAABNWUqVGB4JF+wqASwbNErF8JEKUrCq2P6GAEBj/+5LEEIGXjc03Tpq6QxxApk67UAAJGF2PkT7MSAjMQwMAwCsekMqhDzRqXQ29kvrSx4EjZuH8rLyyvvwzhHjAQBYHlNNM6p7NQmRWoV7NJkux+aUk2rnEW9oI3UUxyAwcOMcAGhTYBIYCg1ldJbJh+DLT7sbfq7IXoqVHyO1TstTspJ1Jbmxss9MxjQJA4nzWp6Wgk62epFl0dOXXRotrutan0e6jR2mb+3//OdVX8oAY5lTwwA4cAJa531iM2a685hqWJgqYxj8DQGFAQhKYaiWaQrmfZyUDQYgZUJAGLBEAUJBOwYjF6PodxVJoridQukHRiYgYPCAzxHDLGYypaMki+QMWgGgcG+RA3NDQ2OmZVNCeMzQdQ8juSPnyyaOkiySRxaSSl1onHKZKkkITh8otYGJmOBADgoAxlzY8cRLAYTOm91o2d6fe2iip9aJTr1779rLUeWyhVMpptpP2qV/5lreqhVq628+2dX6P//LP9fpe3/Pq/bbRJSjFQrbaZLatTaIBGplqirfg919DnMChbYZW5IIRnxAVGi8yTPEU//uSxBUAG5GHb7mcgBIbK6r/tUAA54War317rQcgLBmjt8pHQR4RbKlxeg9ji8JfppKWPMvLwK2l6wcethti3qOyhiz6aU41oVLHEj79uvKFD2HoOoLAEB5a8oziON+9OU9hnkovWYjBEOUcvilLupIqS12xb1lZl8vw9K1nUCIzIasyTmc2/r5rmWqXW+8zl9yxYz+xdddU6QjOGXxN/aRia32K/jrH8Mt8/Xe/23h/f////n62TECzERjFNzPn5465vCXMFwgyQwQAIAESIKEZ3SdlOtfypVzKUuxRwCQgG8cZ0p4hIHKMhbIRsbGJgbJlw+kXiyGXQxqBys4ZsUCRpPFI+b26iVNkrOj6Tuy0VJKMkqqm6SlKf8McIMkoiRV31SbRXorWkkkbJsijSV///1EzvpIpOtSnrrZ0qPYxJwPZC14nVf//////iGpACACAS9BgGomAEIBGAS0Es6UkAyJCoAGJSCtKQ4mBYIAgFzCdbDxtSTDAIzFcEAMDKP0RpoZl0HsCUdUgYGgCYDQHBlGsJGD0CMKAHpCKNL3TsP/7ksQpgF4GETUO+rVDKMHmoe1S4IgBaK1EbVmsmAnHGJXHHHhM/NV6SU/rTldjMukMtuwxD8gidNHMqTPCmxpKTdSrbYgGBNiwJDvtlMAgEeW4X535SbmQZYLzXOLoEw065iqboM552RUty8ZPM0LOZ0i+BhsEG7Uy0paLsk27I2WtGtFy6OcFjQGKlqA0BSDGqRdUtetbVX7r3t6jZdFtf/2nVLUXNP/1f/0Q6wybzM8jYAAJfkwBCto6+m6ZxRU0KMEMQpc6gBZ8wCgHjBhEfM1cWgWDAMCYAZU7+XaS1LqV/W5MZFQCCAKMRMmmBMByYBIDCYat7aP0RGt3tU+NYhCQ1J5jsx/439W73bT12bbYmpZ7r087hLsrdSvvn9+1y7UTLMp3TvepuwAOJsyG/jlMLQD50Kd61oGpmaJprQND7pI7M2ZI11VpqdEA6CVHW1O3dLq77TFIjQsZAzkwCRYiJWRSX1/+r+pW/t//1lpam1////yaEyeWaqIAABEdotwlr8vbeZYRdnDEZB4dcJEEKgkYXLCdPI0YOgkYnAf/+5LEEoCY3g80zvqUwv5BJp3fUiiDgGWq70Oz0td6VOisEMAiYBoNBlNL3GBuBoYBQB7cp9oUgFgEZ/uF/CidZpna39xz5rPu+4vBhnti1msvOV3dEwRN0HZaDE8eJoDMUgLGjUoADDhJT6csmZimKURpKTqOPRWz001U/WhfvvuiZAidlZlKSQSNkk00kloqdSK1MnSMDorgavAavA4AnTv31/tS/tX1//96jWo01P///+dGlmPQABBS0EYYg0JubJK7pN/TmJ6DQwu9BIYDgqYlGUdnJOUEeYJgGziG5Rjdl0phlylbSzxgPA0mgCluYTAEYGBChMAOC0oaAGvU9ze66jcCW69TLdLzHHt7dqn7yrC8jpYqapJjZHoLdMvjwBoSwFhhTOgQGk4fQl01qFLqc89rueLyaLLTUmpdL1U2W3ZdRGgDIDWfLZVOy7cxXc8i5ucNDqbmxgT5cFBjOAYpGRql1/93//////nDe7av///5ZVW8AAAClT0O63zmv8veUvHGpAYMwo7QINWUFgFzAjGAMo0ScwEgEzBVAQBw//uSxBWBmPILMQ8ymIL8QSYx5MsQBqlz8xqrnTMGaCkEHAKmB6AYbExwBh6gBCQLosAGwlwknUiaOX0VXScCpbuy4hrrFTo3a7ZQvaENpY6krRRZ6G1czLnUlImQnsDAYQtiRw/B+gqzz0iHJKE4KSMVV2m6BombHEpxZeqo0tbPuqtlj8Bhx5lTRKyVVdlNU1NnS5ioxD9QEog5yNn2r1L/7K9v2//+S+e7f///mJIsoOAgDOabOz9rrosEtvDFIfMF0SpPtYiAMwDAEjBRC/MucR4oCRMA4ARgcUicSlMx15XnXADgBzA6AUNh8L4w7ADCYF8OAESocdbCjlJ3HPugoTikyy3OlNJU4yamQwVE1uguanKr3ZfYueRNljLAeQDvKhYDLxdQol1ZRSFvWiinXmhTPpu2mfMkK3fWhdT/eUwactio48oKKLnETjnlmhutbmFUvEw5QGSC/47L/67dW///b//zqSltot////NVPEAAAAACjtNDTQWcsTXXH8IAiJgwCZqhiTOR0BQwHhRTI0EMMBEAowSgCS1zBX6gWf/7ksQYgNqlyS9PGppC46smEeim8Os00zDiPZgBAIGBaECbAyHphfgfmBQAIFQBUF0VFKy6b8SWn/KeaVN26WtLbNJMSsIi7LvRJ5bBj2GqLezjYpE2TLizoxgGDUD4HXFPGgUTHOoG40HdJ003SKc4o+paaRx6LMujdFJbqZG7OUACBppIoYDFNVD8XiZPE+amBZNTE2K5RGoeTLJdL45hDxVCApO1V7eu/0f/vqb/f+s0mJ3et/8RiVQEAD8HMgBtnhRwl8vSFjhgkh2M6aejYYAIApgeBMGS8GqLA9AYBdukB0G57C1cbunoFQCzASB6M9dQYwQAPAEA2lQ1wTmKQBSHDIxZaBgXUTx8wQOS8amak3KTqcqIrN1Ghwun0tFaE8gblNRiA/iSrOETLqzdlsod5wrLsmlSOqQM6jdBaKkU9N9amfZT3RTACRuyDBwotp6MrsibVRIpaQsupsEU2QCjQMjNN3//1VhMktO5H+kKCAAAAAAAUX+/KplxnXzuL3j5kx7t5Ns+CwJMJyI9C6QACzHIEQ1ZdGaaZpoy+rb/+5LEGAGW4VsvrlmVwqIrpfHntxhElSwFgQiPA05YTAAByAQAAPTEzLREgUAmVTBNNNnHOUXknNzx80LKCCJ03VUPJgiZmzGqRTQQqTUkkjUbOFoJEzBQ8nzQ2SQWTBJqYyrrWpBi8bTO0wXQVdbUWuvUyalogNANKmHD9o+oe2o0Zr6ewk68K3pefS0Gl9Q8WZs///EXOt0RT+sSEgDP4sKxFij+sQrU8y7xghhtMXa4puBAAjA7B7Ml8KgaBhAgATd5JdrZv68zTl+qiLImAWDcYDiyhgrgRPG4qNLNl+kQBtSznUuyzKzceT1nxuaPG35MVbkp4USSstqSbrmnxPbUW8wjxeydtCOZH1cz4Jhoav7VpnVrUtlXZmfdt2tdzAY4c9MQgEkTUiWNXTZbLfZnZ9kVJqe5cGk0SyaMV7/6v9S1EZgAAAAAAFGPHLYjRWXHsve8zumBsGC2rtL7KgBQID3MSANIRgBAIFlPp+Y1RUdBGXZcpW0s8YCQKJkHpEmDYBOg9Ar6NjZUiVE72H4vwGZm/qbcjWGNppv4wUma//uSxC6AlLV5L68xuMJfLSX11asYo2LXcgu/Sd2dd1i78J/GEGgrfrw95URkE7qsnWsw66DIt6//nQUhGi8zUSVaCboLJFaSaTNJzVImRWbByCYQPWdb+f5X//2fWHJQQAABB+FuZYrDocAEw1Z7o0YXlQ16A1hAMAZhYJxwkO4kLRfd8Jmgr0mNNLoy7xd0wVCI72xox9AovzG3jgpgKfNe7ZywWaUGmdg5KiKpX9siB6L4hVUyONpWfnbcPdEkCuDTjRdkWkqQibep66OLjie0x8717fygB6X7lbIyG0VqqyI3dCARgrjVH1PLcW2p5P//7rWqLUAAAAM/3hhcihxid2di+BkR2to8ahhCEwrRjkclFQiAkUga06HYeldyrGWnMlIgUPAwmmKRiJDECQC6vFqOm0pg05Kpnlm/yIxWzcqzk9Hs70u/X6yqUznz+M/VuS+t9i3n97XN1t2NUjwS9dNfKW372Na8TzRSaKqLqWdKnVZq0jyauv/qmYI8nZ7KOLdddFJrGCaCJ3pLqGIPU6hXyzvz21EzEHU/bd8mhP/7ksRWAdWZeSkuebVCp60lEee26LQSIMKkokrzWXsmplrNYwOw1lntotcSAMMEUD0yzwiAUDaIwCmiulH7FiU0mocTHDABDApAlNIoSswmwFRoAQvWpmQQlZf2uFDrNNIzLN7zQIECDWPrUvxIuTy9/CVEV7FzSNbXxFtFe5iLqKLlooYMk9ZITCq6wv7f+s2GXWXt931Tbb3rXroAZra9RmjQ60V6D60qnJzkwfjI1ddqB7kGE06bf//a4YK/RRLMAAAAAARVrKHW0eRrq94agNlz+mCw7ymgaqVAAKpamIxPJGCwasmitqit6ywlb+KnAAUHRsBGIQFQ+ziEv+zxnFXPPv5RhB55DaTkan9yuu+taXVMWuvXqv9uoVo2yAthjZbXtU018z1X2nQXnmfyM//73BN/c4gOmu7roUPdXKO50+WCoA+WS+UbVuXKtdQxQ7AEYV3+l7dXGXZRu2/LjGBWGI5T/sMLjgoH0ysgUwcDEBAB2RP7KojKL9iGXoUbEABAFBpMyRHkwPwI09GJqduY+6EdShprGb2g0fNt2lj/+5LEcQGSTXkvrqVZAoOrJOXktxCh4qluaSRWLntXSTnKbK+bd5jLPoJOIU6D0YhbmNjzIrLg8jZ0EqmRpGhs6HzNbe/9WdB2NPb09VNaKnrdk3OXXqYcA2hTIt+jsTjxmttaDQVVAcQAAAAARzV2qy2UrOdWPx2TGOV7aOGpQFwswD0Mj9zAwUSXlevNS26WM2oCg1fA6BioMhjKpcAUDgtCvhrDNntGgAHzv3JzLkfilPfmf7jfnedwwzxypar2V6tWlyi+6WzS5bx/ff3crTDcKdhdK8d6z+MrxFzHzejFSriobZlU69/b38oAPefSjWXXe7VVNtjINw41dC/u79X9HrCZg7g9kghT8OpDDd4EgowEQlmzvw0NIgwLwBDI5AsDgTQSAAyl9qW5R5RmMvsz0KgBAQFMwfUQzBUAdTqaO1OlfYmADd21SU3WUMv9Z3ZYomaV7Oxe9pZ67ZnrDqij8583YjoxdwdlASW/q1mryY0rfZ7s6WLJrVr8zQ5v/9HUHj5FtOzldVV85kbsrUFYlOup//93e7//oR/EAAAC//uSxJ2B07FrJ435VUJhKyTR5isgPv3YcZ1PsTktR1oLMCCXYasAreKAUYDn+YQncYFAAPCys55a78yirDUidGXFwTBcQjhL3DF0Ah4CIU13lmBRkZ3zdfzKqNHw2vdUde2vPuBlcQdwmaDV1Hj4+80zp/netN4UGhjzs+6UxSWdUxPamM5+b3v81pStR5t2zT69TACqTdlN7oqIrOaiZi6MYYFsltQun//t///oFcwAUsuPRPNkvuLTvzA77CElnWV+X4V+YgCmc2ASChWMCABWGiMqiPZ6QxGBlqonGCQLnlNthCGlYKwh9D/QwOpZZ5cQYDxZcVllrA3SMzu6WliZnohdIEF9ArCibxbFK1tND+JEIPMjqImPa240KHE3uWlc1p9wPaLvOIW0WTa7qvU31g7nYy/slWm63vWrq0VGBBM4kQ/en/f///+xCAAELnX0aHFGpyKHn0jazCR5r0XeKAAwKJTFGaOWYUxeCxpPDwFadVwjz6x5xoEZOAAEGA5mvAMwPD5mBUAYRABIC00EPWC1rEai9yZp3XdSHLDruv/7ksTJAJPBWSUuvVdCeyskYde26DQ0NyKNXk9Wjx1O11/V5ZGc4MgO9aldzP9XuUsoobe4YHQBo2klHlKJfGqfCzaksiqy2pqtc7lUn5dh2W1LGrVtAvGtTrXpPWgmySIDAaIFG6k1umvpmNmSTdqrKsgiHKHgytSJ73TWWXVY7/f/TTh5xZ+5qAV9vXA7aLuvMdc4qHgqJgC4hYETGc3D7MNzEgEzC8HC0LXnFtRuGoq4D9l7A4HzA0BINh8ngwxAMDATAjCADBQAYQs6h9GmuFef7IrkmnlEnVdSdTMBzK1NKh8yOltRDTWkPjt6XVh2JCOcSkzZW3fNkaCnlqES8cAamABmVGIHZ0jBVcRiifOL2uuZzQQ7DZPJVgeS0l/tFm3Sn+fTEIIPa61vWPJT1pm/1/95z6fP+70hHemq/UuDF7Hpee2X+KxVle5fd9TCaiIcGAAEtlMukUDXFpR11nzeEVVrBXULdiAMGJZednlgOIBEXGLwJC+RqeqPi1hmZgABGAuDWaPx95gtgRmAQAEjm1VWhR9S+PO5Kaa1JKn/+5LE8QHY6Wsarnm1gzcsowHfPoAPvryJyilxhqkuWsas9K5Zfn86CvPxCQUkspLlbH9d7XtYUm7Sht5W6oMAC1beVXGkKxbFRIoI6LInxqJZMxM3WXzhxa1OyTMpboqqaTwrFsSimavSW7u7M7LSa2mzKQNCVBkLKCa9+75Xrl2Hxpfb/0oMvN0s5AEYlUOS2Ez0xLhAVEnlVIgcYjFKdsB0CheMHgJTmZTKqSzQ2pY5biDoJhYIQzg1eAYBUIwE0lnAcalBQBk79PJs5U0p7og79NGaXB97EO0XcPlM7NzsOyuEySDYCik9Yi0Mz1TV7lalna05DUYdtL2HBAAJA0ZpampXELW7Muu7r6xznZugrdmrGFa+SJomunSd0kKKnRWcBOTRIe91VVP1ItQegm6Ls1BjALeQD7F1LPN5VfO+S4stLUf/wIHA8pTMTj3UVpseFqG2uhVXrUUPLuDIbMKSA7NQwETxYzqsbPAEq7DUhgVPZW0cCQwDuZDTIJAB2MgSILpBl7WhkQD6oY3LKOOPle2PWc9rQz8YGRsON69V//uSxO0B2DVbGq55tUMIK+MB3zawzAuGSMgXTxUnuiUNRiFoFRR4T55p1O4XVi8PUdw0mUMorYCuaWBXohOuTPFd2pvHq2QIcWkdxYaR7R96lz7W9621a80YMre2DfzjN5q7xncnpbf3iDuvtfEFjNF3BtHcRJGx5JDGiJCwOL2XJ360M/y9KpcmCJAAsMIhVYMtdkL72FxusDCQR+AQApXyEwtIg6nE8wkAcwfBJQF2oq/0JmZp0mUoeFgCzADB0MLxcAwcwQDAKAPc6As1mKEP7CZBKLUOPi9TqvxRRqGItJHTnYXFrdJTy7k1Vu3IDhtuucM9k1FPU1Ttqci1PK69V74sonwQADtrnayoaRsTmZY0kKL/mN4bren9nGJNG3f+/3/8U8mMQR4VxL/Hxj5j7nrDhQfjy1mgWjZxXFU7I5vJpB1DOWalRbvYWp//+55caiqnhyaadCnpjcpjkigkkQq1WYMDEQKMUxc7DQgUNBYyLfhmVRi9DToqqtKWFAQSMCAGUyzVUTCiAtMCcAxW1Y1EjsGANQGwJ18qdXqVOP/7ksTxgJldYRYOefRDKati4d8+qG8dqGIes+OXGRuiuoyJiLZgTKZgTysUKkMkhUNvgSZfvmdeevnsE8FaJwqjROODh9R6+aLWcYlJPHhqhYQ6O+rLSNaPNTFs73uJuN8UnpmEXeBVyri8fWJ/eFnzbh2+b01vGdRqSNobCf35ovgT3BSpSTv6NqIiR4oz+jsXOZQ1HpdfdCvHXNl5gMRT+5MFLTGFhcnbQZAIZjCgC0vmIteo5e5Mw+jKV7iQUmBqBcaIR6hhtgJGAoAeIgAUqUcA9g2TTgrpDWpEn5DVCoUDWxMZ0n2n1lzeK5hSjOfCLdsiFEFqwseHzAx43TEzG2qaO5AqiJJHDBwMy4jK2szm1K+aFFmzSeOzucV3G3pSLhmg+HrM2Yuq7mvneJJYY3t3WNZxjWq2rncbyapuPDv97fWxiRvDPdW1HCxsHGGwtPAa8/03Iuv2//sQSgKEBACBNZw8/Lap1RJ7EdX6MDn9PhJUUAgFCZip0HQoyDiGHE9Lh+rDjRGVQ7SIrFYATRHgLTRxEnMJoAIWA7MAQAT/+5LE7QPZPWsUDnn0QzOsIkHfPoAVAGDDCBAPC0cxOWJdwFMjGOHNAY14/mZadtjku0q4qNiR2l0ni8z1cGIqVBJCh5fqdXOpojOTFZJRpBHCyy0dsDCdacYG2JB9IksFaORxZpLxos95v6TW/rqFTGbvb2LDH7nFtX+bwv8TY3qTT21bY+c7gTwwvUKv4Gf4QEe5hMS9bemi377tv0hQZSBC7hYgrdadorFCpwYBCo3zJHmcEwdEw25C8FAaBgKVK5VmXROfvSOGFB0XjAcKzxJpzHUCzAAAH3YWihDywsUNmyxv2VMyN7U2wqOlXpsrCmj1ozzyNUduRatftLXfVtfG47+NBj1fu4Y+W2Bm0HVAmIR5QwocjDXE8ObLWI5hdWu791c11NOgJXIiLFQnFXw0+yq0+kVpiYFR4cUIW/93///+9iJ2YZbZ7ZBHHmjkDzDNjEKPijgOuAAcYrpZ2OcGIAgJGRWNdkDOw0yHJmJNbUUHAqYFwOxnupQGCEA4DgM0CQwAAmWiiGAMttEopLNx2tHlxVijOhjfMLEaT+dv//uSxOgA2e1pEw559AKVq2LV16LgwdqHL5HPKDuYkJH03nIrGd6+juU1sHkwvEWsnJtUuYsjnHkhMi4TPYYaw01o7qfyaQqZMsr+RXTMUfNIlr136Ux9QoOrXLxFhLvONZ9cXje2rZ1asaM8neeH83mjEbfPI+Y15BOcdL5eqil/RsXx21SkG0nIs8qGoM1lbyxqNRF6aJ+WJqJAQFqI2UEI8AEYGwUJkYATAoDYwGgBVApXSPHLqktrv8tkUAUMAUHcxwEoTA3Ada4zdTdFl5iYBa/Kq1JnMmIKucEsxqxlV7uJK6jP29jfH+XlzbqouO32OmJEh+PedolUzJD0XeKf0QkSEYc2JaZ1Suo61Nq01I8y6OcvJwSvN0XKIHtSOfdU1SzcNoDdhwNuoqIl0ibjuJq1VYZKHYiANBEPDsY9E7nIzadH8vepv3JxtL8xf6s4MZlLqS+fyjTNTDJnYg1NBwQhMw0zjpDpIi0RDJGiOyl1nUxZFRvGh8IwuOhCGGAm8YIIGxgCgLoahAAbyl1UKXWl7/wnlfr/xSBKepQye//7ksT0AtppZw4OefRDCq1iFeejIBHpyU59j/xC1HpDBT9N/DD/QXBFmxGpfcpLtmphSzNy8w184jmsHSyfurMcHIwOjmtVtrulJWaNXVLm1h7A8/tfr0531pnRX2SpnHv982jytZv9Mv3zb22rqpvDAtDoIVl4I9Co+ODFp+p42tikJa96WlEGkyO0muTsxWC54el7xRyvT0DkOs7RgKAuUa+XMS9MCkGwyHwVwEBaYDYASPrTnZfNpMIfBkK5keTAFAGMCIFEyvUcTCaANdpWiOF7UdC/TnQHLJfOIUJNLaEO7hnQhB6NA/uL6vCQwI1i4lUlkVEgsUFqp5hdOna2iZugLPJuD0foV5wRmjN07z1VYKrDYsRpwhowosXiaym2bxWnZ3dzMpkJzLx93TMz3dk+9tZzPrSnOwrkz0gbzTn3JmS08sA5Nl4DalULXULdcKnZxoNRlb1p2OafAgADFrTUaeExqNUk9A9IYHh63CmAIAhQBACXJq2XwsHIkFjnvlPrAQNOP3Xgh3gIAJgaIB8VOQOTIMABOVtkOyNrJZ//+5LE74LZqWUODnmVQzctIZXmPzCUS+k7SxXKj6+FBKhgx6a5xxisWhwX2C40SiUKZQl5FutpsrYpci1dU7qKvp7bKGVSmaou9ml7pD8GrO0XFKzTzNsncmZv97fLt+wyu6tnPnp/Nrfpyud/9dvOrRD45C0IKu61871aVthx9qFYYpU2g8DCMZSN4loOnJDDT2U9FHeUtDDcIMAg6stonelIIilNLA4LXAIPVLorPbdCTQDLZezEHA2YRAQfngKY5AkNAMjYqYE2FqNBdW29vl/CZYD2JBphtk76rnWA2ri88BHq5nIapW9kcoUSHmGS2WeSSEKQYTHiqBjSRul0MKqcqksdBaCxKhttMidnu/VbVesy8+R/qr31//9q/V7ONVCszsP0NqtJLLKCmjrvAlrgMimA2NrOlUH2QhQKnN6DSgAACAh2Fi07lNpAlxrzyPKvwUF5dBU7OEOphwFHejuRBov+sSbkC7nMa85okAU3kcSsCGAmBiaExUocG+IAAggAN/EtHHTXh6amKel5W6+WlqoqJTojs0uc0dPmoIkI//uSxOiD18FnDK6x+YLNq+GB16bYGw7D6DYhE81fsts7d05ODolxWEhcZ2Ai1J2eHRyhNtakPIGGV1CcCwiMohkZdJ8poufp+0yv/md7t7o87ZmZ782eo7Ws5mZW9MrtjE7Q+LZ+aUDRHMDzpbOW4orb+/+CGpvaBb0IZ7j/uma28kEvmLBRPxqMUjrWIddh/n8UZbiy8wMgdqRJjrbGYg5V9MGAygDhL3sNlcOtAVKw15EoUOYUDw7J1wxeDIlAdLFNx7mGL8lV2lrZaYqoUKFotWbmqLHCk5a7Vi46nEUYIRLd199YsWRr7Il9VxWsUGAbRefFs5UOr4S28z1a0oiN245LxudH0tObba1nrf+U2Y8hWQWmVt/vuzN5+Z/ZpMN+n9XetYAujzK88pEsy+8+OKnFFHNahLE1hgBGEZ8XLhuk+RIsGwICYnauW21ySwe+9FfkSaBgLAUsday8JQAIYDICJicg1GAcAOW4htWxtHAWGV1FWkoyFu0GBUEsx3EdzA2AnQdglBxQrgO1RwFU/zM905u4z59fKvcZosbMdv/7ksT2ABn1XwkOeZRLCSyhVb6yGOT07jDwp1VHQqPDpfGbOU88241ql1teIVc7itw5lMwK9hh2aIUd5BYmyEnID+DGeMumHOGXdOadcb7VWPunnXOr54idsul3PdUeSPMY95JGJcaK1TmXFRTrT6+PZzNPq1emxqQr1oFz2fN21LGnfydpzv16PYTAXLFmtsh7Hqth5lcQkx8MfN4nWBoIYPMmQIxCABA6u5xo0vlpjclopFSmlFQcwBAPDCjQIAgCw0AitRerjvwRAGTFu/ZuJEwjeabBsiEMaeeVTovK0SopVWbOkxKVEsX7DpQc5pCQLExhECgSb/lGEIySlW7vTPSPoFsnNRi4SqXjtZGp7PL8rhcchl1lbCObn/8agwrBOTFrg4jm/1/8/jU8qvt3419v5Vd1MTGwerO+qB9uwp7Z3wPM+bp1ZjAIFoS55nBi0elr/SF2GDGHgq7LEn0SLMeC8DoQuuDga8zsQc8ccb5lLTWvFpSwAgQDuYoKIJgXAToII4FQAXvYMRADds1fx2Hyk5D2sMCk1PJVEnJQIi7/+5LE84IZ5aUIrz13SwMzoRW/JonFCAAaHcdcTT7nsXthx1pKGJndDuqm0ZmChlTnV+fskF7krTNXMfe33TKlZ9tnea4uTtPnl88Rva2rRtsVbE4SNjWQHZgfd90i3V2XMrvbPsZ10+Kbdu3/Nf3J+0l0626wVItFYLYsXDR7EAyeIVIpIoTCY/KYJxjz6SFuRg6CTW4slqYCgCYDEcYQDSk2RAVL31lzgRlxKz3tqlegMLAVHF1OGPoFFAKImKytIZSs2RZ01HLLSFhEsWYbImHE5PMiRKHHHBltAnYcCSQ8YmUm5RUkidmRo0DYZJTxcjaaWQ3Xg6MN2lFTDVsQ+/VFnf+y222kjxmaOmdlPWfs1tlqzG3463SyqKDADBm+GfXPF0vPzTHTTbnj2OuGy6G9tc/W5llxVumomav5m9F1sUPvoCdzYfpWnvDCYaed9IEXCYSA2+rgTwAAgEiIBqzMFARLzLtZ8ulojGIkjVH4YLAEjwTGDAUH4MamaQIA4AwQAy/13v8wqNT8koLR0dnOPq0y1+CG3Y/0K+78a131//uQxPICGHm5Bi55dEsUvKEZ1K8gLqGsOPXt2o0vjduQOa59opCXZ+xJbJsON2r8f7nTVcbrq016z1thact00vZ+1I1swTXJzppWLdpt7V6/X+vt5lY3NcjAkfR0czJmevmX+lt63X5qX+QoY5mClKXtHJ47L0qxhYIBOGBvsY60TteDmSPDsN6RIJbgx+o3fddnTxSyKSxUZm5FDLdmTFyjHXM9N8YqLEsuf1PqUS1UzFoFYIMAqKAOGI+KX8zPDcwcAsVAePNGiLGXcznf0SYWo5VviTYx0y2hAoNPlBpzW9wpJ0h4DphQzEAoaCo0kzZ5UQUWYMVJtoDsZaLOfTXLzaDJVyrHMNOWldaiE1hpiYW3eR8vAwZbqjgK2NrNMRqhKtURr74tpqluJd2a61gc8EIOlos6opjLHta8OxMljFTz9lREVPaKMtUGAAWTAcfp8p+Wv5MchowqCFxX9dhaBhAH5nQAw8IaFrd3AYY+bBF9wmONPTqKoMmFwTHYOuGEQVBwFgIDFbFB0tmcS/kjp9Cs1DZpKCYjSpbcNvVR//uSxPOD2koJAg6wecr8QWBBvqKItEVhtJVjxTl6bOW2NI3GhWSzxqicUtLFY55TainrL2Mm6UReOa1k9yCqk8xZLp5P1kLUOv2UhlCKVgdjBaD7oYY3KDmtbQ4rtwSQG1IYlRUUqsMOlD9sFMcXEiEAwOi0Y7maTuPKbs4ZDpmMOwNBBlgoWocaUOUAl0UiEznbmsKeibwwdAR52cuwjeMhoY1Cavd51gn/fpS9bKxpQ4bpIdVhgKKJqpz5hqGoiApl64IlDaSb+SadjUqFYDA4I3Ig+TKI0j7RMRagC51HAhU1LOtBrWVqSQxUmKWCYHhC4hBR1rLki8V8kMgp1SZiQhcj0V7lwHYGxzILPCdlMFKMZPCeDzs/0R5k8NjLNSK6mcZgTHYcUjcsO4MyxM67D4pjQfNLUY36dQKIKHTMUZIiLVBqKINqTPZxD9M2d92q0UEvsq4wJgD39dlpDGQYCUYT4BKGZgKgAJC0TiNyiLI0AbgJ7toYBgAYgCMMJhLQwbQUgIAAYAIBStSKy5UYKe/aqy2MU1rmhmUxasqWyf/7ksTxAxlSCwJOpHlK+8AgidSPGZYUUyZpDKcY+O9PIpGyiR9gBWYWHnefi+NLe6LKc3S0HaBTF+jVcrCaU5tLhRLdNKMeMbKJ5DFmZ2W7uVvxBRRmTe9SpuWnI5u4gbRulLf36KXF1jXswtjnnJTfIgfL25WXn1lsx6fXqTb+cXm+I5mK1C1poMRKNS6MNtGYCjLzS2hdAycOisJetxB4DORJnabV4pAp00dx5NMJ0ughzJhILB2cn9aYZBGYBAQgFWiwXQ8AWN21hoBExZZGCY0QAKMtyZ/T0o610QIV3v6U6re2q9qdwDk+UeUxZnuOamMyyNDHyKY6k07d0eu3QT6Qx3yH7zSEP0E3JnqJQ0Vps74a6k3wlv3d1319qDh8Ofq/n4uzlWmZuZpVN8wjl2qln4bpF4Sgs+Usr5q6fcd8x2so2Sm+4dKKAABMCNFFJwLMvntUmc92UvgYQAtWvLosSAkFExLN3K1mVx+VUEMq0AIEsVBgPDhMfOqgk9w4cwVbGgJR167n6++SS/h3AOrhXacWrT7itrBnaOGQRNP/+5LE8oNZrg0ADyTYwwTBYAW+morsw0dMCulTG465vpYVl6cDH+3ez93MmCjm2L27uURveNzdr6W73X8lsixCKiazO0bCGHp4b0ypuXSbUOxqJ64w/Ms2jS7t7mktktTkts/6TxbuRUwpNo9dozFszYyYOOPtsJAFQAly5L3OhOtIf6q9FY2pxdcTcZxUEBzEpMHLtvYptIUMWZwMxxTNKBEwoFmIgHH3ZxA5ZTBsFQwCGl307lSV8pb2+olu2wRCK2cSyWlHu3KYFkxWp2uFcuANGMTcMQCiCykjjyHlruiLBRuIpqUPNJkDLbCiOAfBSZmFnbAo05yYXuVZWCFOWChZwWtAQYxZTscDFkqo84RCeMaXaqH4dQibE2VfvTrN6hzmRITDlkIepjzCKKN+8fCOCynIrqXbRakUiKYxff45SAIjCAd5W9UQJe7EzAtHTN2pZl1HfNEXmJJVjhKWOaFcaGqG89sgUvYskG3zkAkCZgUYPgKdnUuYuhuVgAgJbC+Sq6V9J9bC2iWQXZgMhFkDjjlXoVYNKWYeZnrC6I+h//uSxPGCFvGjB04w1otKwZ+VrpqIIZ1zyBy0FnhZrpoXOQtM9A0s0TijTy0teLik90ono1n13v7rwUoprx/sJU0IPZcE0+T9GIoUTRU7qop4uA/OQtAprXAMXRxMiJ2ju4Dk2aBmSB7MJpOnrRi8dCE0zc0iZKdXY2iCZ9rfES9uTdo0pGlzEEgR4YzLLNJGpNDsQfwwPAxx3+szgBAcxTA6BcLFlmDNW6peujDLoMFAoFgwYDdnbAAFT9srdh730UQ7VorFOgYDyyAUcTLGatVKyXMVQt3Nmk4LsS2SWs5mPxx3VZrLsG41O5HJo4JrxT7UUkeMsoxMoyp7XCNvpcnnSdMeS62vWurkpEoWSOs+sc8stCWGu8HjTzrhdM3Dkt0qEHajaWtOIjC0n/UcestPUTDFZ7JUikIBTYXOPeIW+JViGrbTb1tP9psRFAjCACYDrOY2KDYXOxnkckkNlnX1vWacUB8wiAhm7QYCo36VXhmcVgY+X7R3ZIYIiaZDa6YQA6DQE23OBXGUZ3fr3eSI4Mxm0aQHifsiKySCBc/Jbv/7ksTygVlGCv4tdNRLIkBf1dSbIR12d/p6aKamI3rEp3+M7w9iQTnWxNAmVLQ/Jal+bB4ljUiWcovQJM/HbUsjXNDaVJd2yqPanqPJb1fdoIQi+GGWjg5hZb3FbuIlbUuLvKtIrl6TRVbT9OdAqS0EUUeoaSJwiUis3wZJSFWtaZhp8RNSb0I0maupS/PIPv0tmDc27u8XupYtLc2WGJQCuFCX+bdu72OczWB2nKZpFDgAAwNjRDODEEDBQBF7SiKPKxWntWvqIKKIzay4QYO7z3jXglztDjidWmmksXbaWBqsnAeTdgEWrNPR5yydJoXpxTIHWeRnogy0gjGJ60szNg4gdRNHdc3eU5JDwpqWRrXPPMOdAwKtzjdgp7OeCaUJp4udZDJaIJQny6vMlyemhF7my09Q3lH21XS84sJxpFjaFa2ISnDELlnkyFakl0Mm6i/jkuzYn6GS7fqq/q5YFl+UVHFF73tfOGGuuKrxu7KmILQTHUoEjAoNTbeFRo3SYAxoCE0HEU6YNUxk13SI3anm+ssUcxBi5YtJGZkleFH/+5LE74JZBgr+rqTYSxzBH4HTJzj4sOEOslMHecVCA0CTIxS8z4p20cRJRu4iKgJiKpPRZpoaDMQslMYEomCKIu6aMvSR2gSBp9ImSm5E9AdzkXKHt2EUpImh0UwWEbcaFslhhcZdhoP08wpb5oGgfCefQeh4Jppi+hIU2rwhdHQ5pRq7EgeprpgiwCwRsTB3HdS/ljfvU+U1uhqzr9BwindQB1UkIfyZf2FtAUOWDDBkfEVAcKy/K0XChh63JorONWvGqKngXPLer1jG51xkJrw1wMDcsgUDkYeD4BkuHo7MQiEaEGGVdqfWJfTrEKIIvek2jGIi6NKc3SoGmoXqh2iQtMRZLaTMKx0MWpqSWWkVQ6kuuoKNPY7pCHC9WQdEXZI/CB8lJoOeTcJcSpXBugP07buy2tEEGXrMXK+9WRSLUokhDLFJ3ni2lqi6UhkyWWgSGADAACmq5dJKPG8rN5p29pmgGaWCExObCfxolGPpnatz8xONkgGPOqAMOo8C1LZ949SzLCfxwTKLkp1hDay6Fcq0GFhCuLNigjYaOJSU//uSxO4DWOX0/Ax01EsbwR+FwydxYroXydJh9rqeMmiVaE1UzWVdVOlisZuYjUnpESEq0rOZdR602qjqksq2Sz31i11KjfUIFGUxQjm99VPUnyy4NRTazG3TaUcq1Cu3R0kXvuE3Wl19vSLKK7OcjvbVWXPwgU1Lq6upCCJpuCK4Jo15lfXi2RN4ggy8hh2byKxqvl9WUWan3r9L81R97DCJNvc9KWfuW3Ceaalis5ZjKHLOdQ9F13Frzud6T/2ctXLlaQTOWWFTl50b7scClkjcRzoArk0rpyLECtXApApMZ53Ict4OIxSfRrl2VtG2Q2QWQnkEDk1y1nrcxfMQkhLEYsx8soihpkI4ROR0wtNRxMmHsq6wUlF2UiS4+CqUKO5Oh9IGJOB6wYs+9WRqlYyYw+rkVKZIbEjBKcpNJpxE1eI4rMajeSNSb2FwtapG5lIIEgYCY7iPU+NPvmdnCXTdykpLrwQHq/UnaFLWjU1bCy1+I4ikYIFxuWXBhUrwFDjZ4SLqxZ6PIKIJlCyYqJSg+miQRZIFSps2g6FdV8EJjP/7ksTtgVk+BPzH8TKLCMFfgcMncCqk0m6ZGsLyau8isibmugNrqn0MBUmbJH5iUUDC16et3Puv0XMybRXGUkCsOv6RMzYuJjbD8nKZNB6Y/hO0kirZRB5YzLZrSaJcVzmjCK9UBtp8gtHkKgk08KOCx7nkLBojoMDpJlp7dXqzUFiJ7GzTlu4SBfe5GgQ4kCEnU0bjyRa0hxoz7GxVMu46XUCsKo0JpdaqCHFrpUABmKUjSBYlVoSVofhCbUMZQEDRJqPGNTIk2SJZqDkUlYuKH7Sgk0wwgJHICRu005xZtSMZzhl3ky9JTxI9P0nqjvZ9mlVqfWK3s2lkV5GMXNzbThspS1e4Wu0kqp17QjKciNfJLlK1dNuDahCwookqzhxg69xAagsvLXuP6ZfJqlGG7cXIFWURTzRy1nJRbKxVi0ST6iEmQarqDOSbJBrpxe2iugIFwAqPa3n4p57PO3SY2O2fq1I/BHcI3BTpSiPu86LfOWwpX6dwUkGY1LWZAiBg9BGgXGIikcG0IqNjYCqlXGkYYiRaJ4ttpNVS5iyCVLD/+5LE7gBY4gz8riTXwxdBH4D+JkhhJZSC+S4vGPvqSWH38wYb8mpOlJMi6PRz3buW3MVsQkelJM9Bjvyw6JMgBGsT+Fy0toH6qSk7zKcHonCITAr7hA8kEo7aBZJrykIMoZUgYomJdFBEkeL51ploFDVYBEt8GILmW/ii2s7rTOLFsjqKJTmjnbYAHPtr1xrzGFflatcjWpil2rDN08plE9BzpRmRTzpMjaukeKzcrgOm6SjBGohaJJ6bJiRG9ZVWIgMLn1m2iRdEUTmqaDyU0MbmxWMLQYxpENfdyKNxOvraNEsfS0dM7SYx1VjcipVhClOSzK09jIWtEgZNI9a1YoiJTiFthVKbkMFUEaohhSqFCdnh9dLVU1CNazK1OJdYPqIYE8UvEhetVMOueoV2ZTSIkFhqJzxRCGMmEno2XCvZ0whXRvuacDjlcMvmxFuSJFW+U26VIAAAEoWBRs8l3OerqNAyzqdvhKuDdXOZ8Lt2NOdb9tX6kCCA2UZLp/YYua4SrFEGInGOiUaao0skejaJV5taFmr3LD1kuedkOS5x//uSxO4CGHIK/s2k1os2QV9FjaT5JiCV0s/wiko4eGlyT829S0YklIOxkBBMHUizmpLA3NCcLw0gaRIvOan4UWPcahoIn9FmlFQs4xEmUTUFAl5YJOIayyiJ/IGmk/Q1WUiRQhAxrK6IoxmKgqUkC8aTpnJdDUSxYk0tyeAXAoVaz3SS1VEyKcmUKAqCQBlOntbzbtH0/gsOblis+hqR2Yo7qqFOvdrDvIZssPJyNL9T9psoabolbjGSgqhF85JSceXXyR0jcyeogTpOL1V2kJPBEpNeGp63KY+ij5NmDck3moj6tRiZSQtFdZXc3qGZaKSaj1axhonklIUfk+rPtJsgabIWhTCdJpQRMTmbanopblEdbJmzwoZWZFWqr8QkLaaJhmrkSOKKWZH9Qyns0qimVh0mU+Wdh9QRq6ytAfyVFFniohbsPonJsJ8mYcFLS1TZE4sFuSw0CwszE/gzxGVtdTNcdEpRtlfq9aW1an1SznKnzIcM4zNu7Wn1hwSCG5I5tsKqqxJCHF1D0Ec0ytTnMlT2yG2znTUZmdSihSgws//7ksTsAdgaCvyn6NJLKUDfQPwmEUqtGSj0XVlXkSYaaLayStTMFCFm4zVLwgqdVaoP1NXDxYkTdrTkVF8kUmBdWibgRijcVk0kK2ZEy7dzXxsmXZRi69GUaL0q9qLdPuSqFFdsrtzMpMpPjJA6aeqqQT8kzGxa1ZphVoeJkmyOVNvisqjo+0ZgyshRkiKLS0NeCkEY5MvJQcyv9u38rd3CzrGdv5RKkwl8klD4w5BbpNkTuBGyMTW31hsE0ck7aRRuJ5AjWjVkSE5+5m4sLlowLddtpRTYTQImoXBJehC2ycqb053Xt61EkquVVQYiaaOLr0RgN8IucqEXgLOoy4DEzOSONcGuHaPKgmxtWcUbmlkORpEhrpD3hC7SdNF0V9Eo886YY4jOyWe0vUuFnGJSgkGSwka5YGFQfz/lECj5SKhGPmSgraQOSRzFJJ3VIAkIyJozt08Xn6XtPUzvR+mtVe2qbcSl79typp9qbDmfsqcQ+7y+TiM5a2cFKExFpkuuGx8isoEzIpI5kzDYpMrRDQI1AZwqtAcxVhAQrBBRWLP/+5LE7QFZXgb6B+k0Cu1Bn5WUmuADZ9ChboQNoNmgbOKxhyxtC3TyNEWJo5sGGgQTQKLRWkUPrzAg1AlchZWLrRMINFZdYYeUPKodWx0P91JSsndsrhh7FEEHnE5LvtCjOZlI4oRt65qe1E+zaBZJKgGKkqpEbuBpapRPG4eKqb3L3NJoVFXFsPQkhFyNpA0q/GYnrmqk7QnjEXT2eXVpa6fVfQ4FrTxtbYWQv5zx5FQXUsK5geIYNdr2dOrzxEtU0SEjLOYGkbaj4ySxVa4ZJKnNautcHR66dRk1jNW5HNZRy7MHW9VQglGC6SFdV6yyW9C3Rua+FZRrVoZm7tm9ZXilJiKy6hWpqrtWnMgidniSaTCT0Cc1HlDKAjpEghJEjQptf6xKSyJaYphOTaTEkuxtrFSVldyqD8U5NdOkD7msm01qNwtR217QR1LdnB0PKNsSJAF0/B99SMz60fOWPV4TvOtKxISsqGqxSPE0jlWP17DitmUw1FnsDYgE4r5DFPvVzInkpkEWqYHZdGSnyuIRkyYI7t1D3TVITMjRkuQs//uSxPAD2sIO+CxlJ8LzwV+A/SaBlGUGEs4TQFovJpoIKFy6uE6JEchjKJyKJ0kXRwo22gRLCgfVVIxTIhKbZGKz5AK6UKxJYlkeKoyN2uPEZhRA/aKFO3OOl3G1lMKQRrlKQHMQkdLyfVlgqgPPEqxETvFTCJ5QsYRxEpIkyu5A40KmEArKpN20KICbqzKGqSzsKGFF3kFCs+9NsjaxS1EJdnawr6p61fOOYUedLRTdPWkcc7UqXaHNCeaqGXTfZ3oYZO0vOQWZTi71RsvWMFgziaYWd685vE/Ay8peRq4fOVFXfY1VE4cO1Qefla5ehWaLB65fcjTUWRTrK5z+Y2/Ok8pS9StE21QyrD7XtQONKG+IEiigdDDeRK0qqcqR6RiAc4eHEFwPMIgSqTBzDiIDtAWJTMyw55VUbmorSVYnkA+SWXDkCT6maqzTbpNz0HlK6AkulNgu6Sk80ris2bBESaodHAcbAsVj5jb3veI8ONXO9dugRldOysrW9vA4NkTUTmLgdBV4qJS2+mm+I3RpuJZgfaOOYN7kSkX30iVZA//7ksTtA1qSCvgH6TQLIMFfRaYa8alSXCsJqdDKe8WgiCHpuuBh35Zs1iZzWiXjyZ41+8c6jbMmSjG10gSUpwj08lcIkyiCmVCRbpE042jzCOaX0iC9f4x14sw2cYwxW6g9SUZIMg4rBmShFIJp2em5tZG0ntyUutY08rLu3l1ppjWYggFFYbRUMtx3K7dSX1pVnSSyhtcnJutX5TuLG8ojD0Mw0M0W0rzOIWHxHFoiIRfmmSFSCJDRglQwFTaOrJUqcoewugZFP5Z5pZoiYbZ5ZbdSkMC9svRtyJRITJEKickRlysSISB9CyPNIUQoTF1CTraJ0BpAXVqcsD0nsnUZxtYlVZGygSRom0ybSBY90Y0amUc10jaJ4qQ4ubPHVwLQyOQQqo22yyq7QikIC0DI4sG20DJUiKJo3IJHJmMkqeUpYsdTpEaYwiYtsqwOoSUpBuRG3bIic3ELkc2qAxAAIAAIWAdH4I2rGW7FCa30VmiRrPYVdPYGzhnUzNLDivXQOjptopQS7C/Vufne498ed+uwOMTNPL4djyE4QE4HNPr/+5LE5QJVYgr+B+jUC2jBHxWNJPhfXwqvg8gYOp4acSIGIJm5qKLmEChgjbbJzIuXiwkXcOooL7LYNIiySBypsefZ+1MZhlEcjKI8sXTXJxKgihVJhoPquZdSFuEDyTVTjR4lQI2k4sKYVYpRJG4+mWIpysy0RkqHUCEjbIYI1DphsvMlJyE4Mo3ONiViY4dJBYnROipN42Y4soKSdJYcoZQrNoYckkgL2ctp9ggK4XIAqDrB0kt+19/Kzcxwq52qTlJlZqVOVbf2N18oNBU4zSWuNTaTxy6g8vNWAZe8VklKIFgCtAxpuMU5a0yZ8LQaz50pKfv1jWZtkuZ1Euf3su8rDpXaLqUVeXjMzZMb5y0XI79pcTuRbP4aGqjtvW6d7rHY76jVvM0HdmnRqRNOdiLQ0aeXj5pTcxKkdbfmZCD48d9d8fMUfNMVGv8qeq8RXGfXJgpiRLL1UslGzTV409n7dNWMfllh42s1LLuz6aD6Fvw5FqYhFJR84ETh51oSWMVyqmICI0piK40yrOPYWKydO1wqoncj8iFclRqE8DbC//uSxOiAG34M+SflNIKcP+BlhJrJpozBC+DKAtBQ0hKiQdII4hRTKnSyctTbOstTLsGVZpkS5YnM8g6ikF1kFapGQhLCI0VRljG40YmwtQrFPTL7RhdMlOuSXxGQjTbhE5sSoUQjYKixcVrL2RpoCUwXeuxn1WPgbg2gLlCdAXJ2GlhKtkIxZZQsRFRRk0cUjM7BCgoiXSg4E3g4tOmF08iQ5myW0OEr293FvJOu3ryBiAuk3jqitL9XjBqSCXTEyFEnhCKiJ0yFYW3TShnXqoSdkq3ZlhEjmoSzfjZA3bR1IusJjVzggQQURzNEbJCk0qaLLICqFNYSWkpjLchUmKbt7Uckqv2kCLoTMheOqJEa59DxKiO6iaLL4hExMwQqopkkWHYzYjRSHJrEI6w4kpTDCSWIkBIoQSEWZOUuKKdGhTI8VSJJNGW0x9YjPNtKESaHIyISMqIiVApKGkECrSpCycMNlYJYCg4ARD80IqZI2TDiBC1qRFh7BaNsnAzeuloqBEonNzKhCYMeCyxKXMSGBLIy9CUXKFEvGZCgcj0xF//7ksTtg9oWCvgH5TQLQUGfAPwmgDdnB/s4neJJ7BomXl4vfqrJe73tXEULL5NKLVskSq33fPXSatQhOKa37XTqMTMGWbUZhNJGmsX2HQIppulKD8dC5NpKOqE0otqsfVxUmkvqjWyrSdZeMnQlM4okxrowJZxXj0NQ6UEKOove3SIjWZneKw0e7K6eo2CVXJ9aLc15D0ALK40GJm4vE48YUkFwei0I5KrFG5dcmqcLT0uJU506tUcm1VEbr7roGv6bGRnqJaysUn60kLiekiW0s9BCtPjzF7FnlyE5A01jTkTBXdXqJWsoZsobhcptsguEjNEmMRqrUgN03GLq55pMpO184hQk9XzS5zIIKnlHLRxLCqTrpDU6NyYsWexV1XCwdssNpUIu3HNXAWFdUhcgQicpQzNyyzT6xeXKimlQcHdSlslcSGBIM0Zw04qTHpFjPligWD9ZeYkOFBXnsJ5c3H47Rl5p9ewnOEXtzAsEVQENIAApKnRcuovGE3WzIVaXM7cl0c45FvxewmtGLQExHHCPDjCNk2E5klqkYqkJc63/+5LE44BXGgz8p5kjw3HBXsGEsCFphkiI48M8GnvRLkCKGWYsgxjQ19LZ+F9ymNTZpJGEsaU4Oq5pUnZsafhU8p0xSt2Io6ttAzUIc5BAfkMXfNVlmmnD7YGwHPOtzzruHVSmaOZUwYfi1y8PJ5FkiSzbu1ke6ZcszFG8ntZSibyQxNyJnNNchi0LlPoGasUgIGQmZKxxsRorjrGC6NGI5DiXTGfBoeaNwfbSxJ0/CCRODo6DCw+yUFaMoIwY0hchJxmLkCMeaUWzomi5PzDVmcbNJQSmnBHIlTNXbJMusfYjIXxNDpk7AnQIUpLPklcqW6S/mfnu2eTcr2xrCIhLFORoG2R2cUB/xUIcIniVjVIwe3ERT6co5lIS7bmLcXcsjbHCHCBIjTks5NJjEUjbqdUXJkvSVcjcSzWOrCXFia1FH2aPRXVJmkmDSKEtM3Esy9VUPrzeBzEDAMSiRp8YPFG+KI2quNtOFUO0XVZkqhbiiRweZb84rlCYpsGLVWaGhvLmwbFTDJtB2RlexYoFCtuDROmjJ3KBY9DSQjIiFtHO//uSxN8CVboK/sSky8sUwd9I8yS4apG5RGuFt0sPIdkUXguKEyacHIWT5XErKNKpIBIxNYuguqVj/yFAqhwgWSRsCo0/ZomMZcf2aweWbRswICi4aoiQw8ArcyNAiTYjIPIm22jJpEIhUiX2U1U5CohzDxciSHFSy2E75EiMUuiw9YhkgWmixRhqe2QPxEhQNckWbZCxFCYPAtOESNwC23o004MLLjyk3FD0DfRW5LEQmJlGWxCxa3RiqYsyWchD4ZIVXsrrzZXFZOfM0YA5AIMIUb2IICy0ZJOlNGmdQEBCRKuFax5qSqDhaQllhm9itTSSqBk+D7JCLjtMLPlFgpjaaJOS+yMTYQyLyNtKWBxCZx1vI1Az4yar4SpsVBGy2oNyE2DKZBbSpKic0oh2RVDPW9QyemjqOLqtqMWsgTUNtF16MovOT0a/QsN4zEsRrHwujRyOnxAIUDK45E8jLRATvcFQmZW0nTSMJlXQWaFkz5mEjcDEydeJwmEzUJmTjFkZxGy2WIqaQpLtSFa+hTqE/FKJmeTbPGKEgmOppt/VpP/7ksTsA9lyCvgHsSCLKcFfAMKkwYZN8zIlM4R2XTcYMiBVZRyEhnNKaoxrZc0Qr9slOs2xahGVOCnG6IPF+rkk1iXdVKoDygqRPawhVeLNsoFw0qRJWRYvFKcyyNGyyvVrWgiqx0aFAaID/DC6FYs21pEfxAKhWfhsCZLU1HnhMcYYVbQ8nGCqrJIYXaLINJeyYFSaq8UUy59ArJw+uEOx6/lhmZhxWFvha824Rp9stZaRmTpDD0kzZ05JFSMvWmjy8cmVpaNZvUcgaCkaOQTKXX+ecj2cmaui6dJx27JXsMJWaeJYp4Cpgi8UqLSZRLFGfc2i0xVHLPsrTaBPOVW3E1VU2P+aVubNZh+URRsnHosFtw/Pw+jT0mY6Fack8ilSyZWjjbiVJRGXsa2kDESR1cwwzcL6qJoQbfQpEc6EKgaqhMcSRSmJKpYyJAwEIgumlkBwpI4YarZWnChJbCUibajQOCQA4bAgy0womKSWiCEtQmQXNowqOAkEIGBwjXwxrMEjzLUWGJuYnZAzCcBUoVzMxCjZUdEw9mBZA09l8or/+5LE54HZdgz4B7EgAoZBn9TwmEiKH22lNj1VIYvacGY3Fh6rdNUk+EcRMttlUFCmbKjM2ECE28mZxsmLIXJ2u6ZMpkGkpKrMiodbitJmGNobNkRDFVNhrZ7c3ybnVWtkkq7NZHybmrGMMa/SZhGdy855bOJ4wAjgA9SQi4ELaBcsrzN29RoQ6ymhJHJom0VkhGTis+bJSq7KiCYvqMUEYpCplsAoiQngXGmoiqxGmaNCDg8FhG25MoZQo2oqNNJuRBWC52J+bSFCjBs2GCVCujmZakslS+yIFSqwHECqNGWSImixZcj7QXFJE9AFpmiBIgCw+QpoTpURqEs/KTDYuaWNK8YPOqRhZDFd0l2vpGlsmxOVFdiMjjkKJiSAGEKyov4kppV6Bhd7byUdaIXk9JgMsTkQuqqmREcUC7idAbMSMkx1CjPrraggycCguecSNj79ECYACcrwHhKD6SyqbTDCtmU5lO1AYVk9HRWeTI2taSlaqUxEiWkRKVM2NKD50lROOFxcycF8Xpt67TKpkhivA891U5DK9ROOzGalAbR0//uSxPcAGFIBA0eZI8t2QV7U9iRQtJiVIW1Vj8VyMlm22jWguq86dQolTBC0KFXokUS00K5C0yy6bTKHTjBMQo1VzThWFzjTlSaV20hdaVlUTPbraaXkTkxaCjBBSUUkFom0BR9yaxJaa6YpIFSDETU7wzMeJnQkqozCa5JixOaURxnGCkoKCEcRzWaX1hsu8IDAC9WCPv2EBxHLo5KtNAiKxESMRpNkc9K2RbGGlrHV5JIRKkJltQTLAGJm0yBAsrTTS8D4tI8gWcK5zNMhk72losUQuQMTZvNLo2kBEt2JW20mQJxoxi2295JNDqqpG2sjQWCaUILpJWIuRDTC72adb0mS5lrrbZ82rKJwPFKORisaJp4KLzJrNsFKaPKLNoZGMQp3CZHVssstHjXQ+JrSTMHos506UckggIueKd2JmF5JES0oWysV1oq09AqgIyVi1GIDBgAGpCWGU8tGOqFpn2SBSfTKTFSyVwLMGm0JoixMvos0w0xBcwVJmjxEi0LoKZTJiMqdFCBDNBrSBCcZmqLUgVJG5Og0i1nGuwqwy//7ksTtgFkyDPqsJSADEUGfVYMkcA4swhxx82chkmqmI5xEKTTiZPCBVuGIl9kjsgUmRrLrPnS8Ek5RXLk5DIUJsN9AZhqjki9bkpRG20ZZOCb42mHm26g1KBhOZCkWNM+TKRtEUImlYpJsWkXtc7InYKXNAsvM4w980DTReoPPKptKpFYqORFFal4JUoCDwRgp0inoj+IUowhYJDQsjRqMYUUdJaCDUaqEwCxIDRI4ToOFjZlHzFTFCcVEZV4w0wiRtNFi5NCkDF49ZZ6bfHndIkZIiNhEh7LSzCcOu3BbDX1pCysTEXik0QtIrmH0os1F3TgFVl19PnXdZsgRMIUBaaM1JBcmpzxOCMpjMI5FTNbUVbgURnBWzNU6jbJ3JILtiif0vFQ3S5xl+P8yOTcD4kZbPO1GdMICNBNlDPJWoycJTi9IUDSZKQprE1F0CyOamTS1GOfajegiCRQMALtlwhMksFkElXwcFhCQHqRE5YgWYacvNxBDECY4ePtYg7Pkwqq0WMEJ5qbcURokH0ALoomHu7KnkowkQGHKxklSwrL/+5DE7QBYrgr6p5kjyxxA31TxJIE8VIqWZfFt65Eo5pINaWZVmw0QxfRFkEavPkUw2SJlGXBhCu1FGaqSnJoaGoE7jKcipVhVTE8ZnJpZFcVTrlCCArJpbA4g87IHwJiTTEmooYEr2DAaojRLScdikyK4F0czqO+K9RkJAsjIrIdRHsQnWici1hW9nHvPr3gYitDysvFUEEE0ixSyVl0kGTUPo8cDMsIVHkrhWVQHFAPRjGEDArTQpDJp5wQI1kApaaxlozSa6KSyOLLVSCbhXNViqIk1Nxk2smKlViJ7KCQZR2QqjbshIMtEjJq0TCJChXI5VFyqJepG4gJqRRFhEiTEypQuiigMH07XRD7KNMla5ttNGaKptqIUbGtPNNsxJCJUjXtOBCRMASIjaxxE0NoJQc8rMF3MiBnkLJy6b1GiTs42RlRPq0EUoxIVIEaisYom6XcjNLCU6ujZkK0YehUiaQn3Xjm8eKmfhs9M94XS3AOUHQJpFnHkkCSKLHC6JUnsIMxLEbJQmAxMqbnEml0bbiRGVZkCTORTqkUIzJ3/+5LE7IPY9gj4B5kiw0RBXwGDJHmF5qtJnRg8Sy6e5MwiJU2Vzz1DiUYKQJTI7NuLb2GvpbGpkqi8VEqomkgSJMJRhCmijE/0IqKxTV6CbKuKwJ0MUnG3EKBd+Cg+yyitEqQqFzru0xrOsKNxiNmmTc7VuZU6z24QXkcnbTK6CclE7b7b4LsrNm2qbbOyQJtoy1KKIN0sKKYZna5gaF2Tll2wLW0TCD7sx7tkTnCU2cRCoH2m13oz810pryIA2iVWoSCB6A0kUijQ3CZ9WkBAoKuxN5Ixja5IQTOnD+LRGikpG2mFzy7lQcRKB8UWSLaX1RGpaiSJltMVIU59tSPlJMVsdVU0UXIZENHWj5zYEryadzmTjRISHW1iTHMEDjxc240WeDxNI8tCLoyyGE6IeIzMGyDSZIkxaEKotyiHV+/zWFRgSlHh4xZ8odPKIs1oUpz00qK3kNIjyJEnIXVADQFhEiiM+ygxta2Ryen6umjTbG4sgmhKwISGSMhGR9fSAMskz0KM4baWJrpHFlZGQEiiU+w+BhQ42QPZfG0aaWoT//uSxOaD184K+gYZLcssQV8A8yTxkkuhMPEJdeSdP5HdITi56bSUUL+6KslMUi2wsq7qLFG0SnizFKSisoElA1NupnzoqMS/XNJI9PF9RQZVek22RtlHIll5SW9oULWxRpmoTyCbDzB9XKpKMtjAnUYFKOLBCsyyMGROhgWkZ9o0cnSjRKsZMI6JlWaciThJeSJEgnILIAdAB8ltJ1SNPSKFuA5o6msrQv08XLOpE8c1VpITmohOBmJtc0kfBlIOkaEfMkgnYZTRCcEkJFFcT0iSOFIPoZdcJQRMMjIy2kRzRoJBUzLlexPOhco7GWiFhcEkmU8JDzbBpDIsiOsrG/DkGqFmGepN6GRORtH12lQl70mSYgzJCztIlVyQ6osksOEmkdPRikSEJngpousIZaJ5dAFNRQJJMogksgRIKIRi0yhadFw4vpES9oLI3fIHlJDSOAUSbz7W8qBdCDEARAD5DOKofqEyzeLjrWF3TPok4iluTj6VKmG5tJShjjyNJzeFyc8PI6ZUJzJHHHkql9Zo6rAvdonNrSP7i7BFVd6rN//7ksToAlhaCPonpSADJEGfWMSa+NJIym1KVkIqmlFVpAwoedZOjRSu4bSBQ6hbwVMH4SNj5CbmjSn5OrGxNuIpY1BtC3SemU7m6SsklXIVfJAc2WWVk+j9+sXN0yxIkIJLrapDCVnTJWZ05EpbuxIlPvUXuJDyTkC1pQdRKm9pyLMk0p4qkzcYSiJWGWyi6wNgpHhJ0hhBNVkyYJjCazaMZIp69dbsU11sXWR68TMSYakwPigVIjUrUguk2w2g2rPFk6hYUebcjG5Nx0JZqdREJnRGXXjMii8Plyhoho34mVokqs0bJaaSSyNVDBJdhmcyE+3aBRpgmYOMoPU5vaZbIlWEyMlJCxFMrp9HBoqbZZPtEv0yYjIj0lnZV4YSuxOwgMxMn0SL9XSE8acoKmyr2lzZvXkqfaJgqJESFbWsk0zR4v2liiR54rXQoVzwmEt0QETrIYilmdUgQN8VBMNwRnQV2VjiwgG0mjBVtZNtCftg6QCpE20k0RtpyTE5pEukmGmDtH12zxUhTRSat7MFiBCdKk5lYsw5xcVETCaFCKH/+5LE6ILX5gr6p7EgCyTBHwD3pAEaPSGDJgySUjJkS6Yhc6PmRqpnXpWqu8jVJDSScqFKaAVLXNsHGUhViBYqgWNw1QkUybSPVESMUtZcCyFcUNZAUxnaE8zBonNsGGlRoG0iITmRpMiIjSNWiNEWUJCCGuplFC4NERM2fZUIJPXNo1kCdLwSRRcsRPYmDEKNRcTJaX2Tm0kBMKGWGRgtpG0ikMUogc1wXaQlkl61SlgWQyyYekDtl9VB9HJ2fjhGSjoSCpzqRACYy+WTgCYpjWcQwEqyRAIMQY/WMi1C2xsPii8PjBTWXWvFW6D4+LmhA4XaJZEtJ6ZwI6omymCyiajzXItl4VZhMKIGJr1EXaC5lyeE8SIkWPvKdBQPBUucEhl41IFO9IIqNEOUUJI2xwNCJrrIHG1MJ8W1FIENijzilNrFe4EmHhkyexKCgQh5BRdolNEaFVCWHiInty602SIhUfIe0Vnj6ZFocrRcdkJzyqsSQ6tQygQk8lElidQXtQ+umYk5Q8SBtAiFbJBLR5qJ9xXTgsj0+SM4SvIK0swo//uSxOqD2j4K+AelIAq0wN+Bh5gBjbof0jB4hXXepoqjRlpcRsISxqGkDBNazApcRCN4UORJw8aRIw/1ReKEVm0ZG5YoTEx0FxkqxB03wgNkeaLqHGDbRTFCvJT+FYSWQCsric10BpMLnGQRWE4oITMVDLQnaE0wchYqKAZaRLtmnwFcEjw0JDtMqBWIyeXTQh9TqQKCklWkNoOpGIRlKO7UXhsIhtPALWVoGFRFmqsjJTTzbbabYqiWHWxWmJWaQppN5iNtGhWfPTRlIYUaJ0T5Euly5RZKZGqYJyPDiSFa5qEImaKGhUQONJMoE2EmNEkitk2oZjEE1EaqyA4hNbOaupGHNB48pAhwgkhR4wfKECa0Sr2OJxxjrGCZEbIMLrtL0xltkSa00EzBtldgeQc2uJOnGOMFEdnEdB/kuVJtXVUx1o2JFon8INEi5eiJt1Mkahwe588YUkaNFlVoqnliZXEIAAGAJK0WsLbvStPOMnlVPNcuyzHzdVKGlUAhm03STTx4uKYednpKKEhGIxBPGGXHKPQZZUfqDxZpPNRNgf/7ksTxg9s+DvYMPSADK8HfAPMkuKTIQnDRuhF6yFs8Mk5ySZQkg/utkN0TESI0lrGpX301kMY6yRhJBK1hmsmn8iiJpO21TkvCDD3f4bhalFlzJpcznQtC6grQyKJHcemsDXunnQ5xie0RRe9IM2pEjkU1LONtiKzMhGSxK0iMchSUnDGU5epEAEynw5MIaxCrLzJ24jps6IkhVIcEwOMpIVoCphdYbmhVIz5AGm1yhRYkqjqRCdOCtBlBU7s5SlRiZpNQuh7khEOg4ljI7OuRDY6LJYB8RKOkhBJEogLGgqXTRliMCBT9NnZEiKCVTi0HcNkwWAgRkhOXGRxXUZxFRdoSsg4G2iGCIhkDIvQpLPRCoSBsLjTa5vMnSAnbGsXI2KSZsGx3QtTWhtchIVRdtIcHF0ZMKiE2RGECa70jwsXeZJS6ElRrnsJBcwSHECjAesbJESJPTwfKERAMpKoSPkbndqIEAAD6MwBSSdt29XM6u9ExDWOG/9VuJtMyuXv3dah1RbcURJaXccuxBtmXJmqB20bhY0ypnpElaCL3tRD/+5LE5YFWKgr9BiTNw3bBntTwpIAtPmnrroQgPwy+1co9a9ubItz9ndSZAkSopCcCoRtaSYug55uHpSR+5+e5IKBbyQ2GDCyqpWEXNIIz6OooNRnW82E3uuCszLbDrn1Mi0OJnr805rFi0zZHUZaq611yPMe0vqopOKwFKmPTjmrrOqEXJwrmHyWkgIiAGZuqFggq2JLoBk7eaIiNQMntSRI0bZsUopqtkLkSBJAVLsDrSFQjCowoqiMJEaq5pTYpmU0iqGyJosjJINqvJCCDyRAXkjCckMlFTCSqAxisWUAfiy7JtNNMUqaNrMMLmERttBz4fUIloNqGsYsB8IYmqQnXm20uwqlykcVTDyyFRDUnLIMJSaiRzGvOCunjJJROpByjZKuJlnrA2umgiF5U9rFhXz7LW1sC6EKkRphHrLIKLtFFmQ86kkK5FLJWjQGk7ZRTR4yZSmOqGFMSCCBIkFAgWXYNrsrS3tDhLBOyM9KMCSQ4RTYkTlDKpphslmVIFsOIRX5vkdIZoVUQ9aspuYkZxmaBCyeNKlx5ohdAiK4s//uSxOSBVlIK/KYZPQM3QV8UwyRhwZkuTQPMnEJEhixASslJGmCROSYYRzMri6yBOLUlWkBuxWROMoZnElGI4kjKLRFTECBc82hZpElSJxpQbVZMF7JILTUefTZe+aE2uuhUWkSORj8WmmBcqTIkdzDQXZNzPJQgKUBfp3g2lmIDbcENqo0RiSazLyaDKFskMkcXzfBJCqqKUQMHw/gVBLkpSKziWEbkeUiksgFCSB5KRTCE/2GRsBWuQMG5MCtiiMuXWmF0yRmHshGDZGyXbaFZrpwhtEuME2xIMKEMCKBddpEpVsGDZOQrLr2siRdKVqRi26S7l5KSGUcmCxFUy3tBNBc1TCxTWFmEEXsLMpIEJEddgZRNm5ZSpghQURbFpAsUbMalizkUvmKDk+guM8QJHktJV460pjShVeS5tJZs/RI1OaxZRAVttJ0DThCXaMSckWc5KK8edXbbNGiXoZUCAwAAFGLwmqEmDDrJg+Xrld0mmmoWaWK4h1DM8iMsYrR5dA8osqnABSUiB0aE5kVigVwvKmsM4WNQPbTLlBcmgP/7ksTqglnGCvgMJSALFkGfVPMkeNK2sy7WZ6lKw0xE8diZUi2tNY8KljCNAhYlSlsD6AOuhNmZY4aVb6arRAaWdNYvNGixFE4knCVFSBAvdcok2ZqZpec0tqCyFiVwbaiqde8qYyM6WIHkVHE0bRLJdGTnBtJiKSGVwIaYR3ex8lZQVqKjcDSaFGiQo5EuCt2dW5/PIgSWiwtswgCEsckIWrnViEkaaySic7gHZpCj7QSWvJIzRyQOTM9t+dulQUICM8KipOzR68mvbBg/JYhPRR1KJdVJTGr58iITE1pmlUb12Ea5b2gLJqagNKaQI4RwhKSihfIbynIUMHsNOSivKSgjXKwooyhnAcbm/UmkRq9ha6Bb3JiOl0PQoRuEG7nFdePOqwojRpIuQZZDVrRLqKGDSayo1aDtNk7cmqimXTIUlGIMxRtMMRxppBNOoo3UjhBa0ZxlrCJR2AYh6B8zCZazZ1ZzUbsPKi4ljOC7GpoeH0KwtwFIuwnUCgmIC4iJUFEzRqIwJe6UEUyYabOWJFmiMD1ZW4lJiQgnM7ohKOP/+5LE5wBY7gr6x70gCwJB31TDJPglkJEXiobO5qpAquiBfGY1BxqczxMycOI1tJIrn3DxOsf8CUjC5RmSCpB9iPw2cMbEsdIV7PEhCkbNWhEbKLSj2WBh9tYkbbeoTScrjLkSFHCtDheeLmRKSQF0cX7laGFY3E4fup1q+FteWXmP5BNRPOVRkuMV0UThtz9EE+s8zexxGwdpx9ueG9Frqll30OrHzDBFjKdUOPgZcXtt5JJleH7dn12k1WowUmi05hyLC1IBFJOEHNFyUeGSUWk6epwTJAm0xEkaghpyOre0nQMVhHC4IhVaU9mOfqNkzdXUKdrYCTOd8ex5WWXdlLYtRSqJS6CSXYo2NAvcSAwy2P7mYulIpVpptClzD7ndDSyqwx0gU3DYs6zEBAeZgx8PQhJMu02tkijnPR2TAx+EgS46ZoEZx2PVnqk5E8eYXN4ONgeZgw606b5CRlJvJURQ+odRLIrNKMtE5xhheZgwewwxEeJmCQvBledDcbaY5tNJO2PGBsL8UCZYus2rSMhGntHpl5krBpQRrak2krA///uSxOmD2v4K9gYll8q3wZ+A9Jk4ELQSYksdxRutSQWmjIlFYlyVCjEzMZjiE5UMzrqtohUvhzmcNsizAoEtpE0WSQq+czRhU9IqogUP6mKF5nXFlrRKoOR15Ij6qjRs1ZJFEMImIpyOStCNOYHEnEi7JOtaNAREp0w0bKikl1R+NVp/wFJgqkmXisLm1kMdpsTWlGSJnhoC21zplk4OyNosfSpikKFt6NiOJYgQvRqNFEydFWroGuRl2aQtuZPukpRMjuCx1JtuaxN/a6Kza2o6mPtxRIlsUksJFYqG0GU3Ka7lkpuStU6Rt6zarZmDNbFUQQaQtHEMG5peEYJIShlttA08tHWlAskurM/Nu5KG8qkUsLUk7UbSTUXRdJtk5AfybTyGKzCrK5WBo8iUMvUUIknJKGIGTzoqECFSNMN9EhHfk2GMkKdkvYi9vghIjxOWOOwMKtoAZIJl5jqzaRZQ6kYRoJmionZkvAhcdWkK4syqCGahvEcXoxpTorN4eRm6VKuRI5EyJplKl3rG0JQ8hOpUmjPGolXayoKpyeiasP/7ksTtA9l6CvgMPSALBUHfQYSkANZZBTjhtsZJ0jp8VrQV8rsnmQn0Cp1DNuCV4bLqWqQS2K8oECyzLiDwPokYOTbgs2kNnzmEZnEGaUQpQLvSaGUJK3ahJJdwoJ3AgS5TBPrdChssFyck2ZVEKTWjJTRXBW0BZAkdkeI5FSchTdRP4ChcnDKlAdJBtImi7eInPLwBQ5oO4LeKx+KT4rrMqEENYJ4mB3WJIEdSZxYlSjEfHAFWFKIqTQUUEmEfO2oci2yvTaOJqBciRYiahC20hy9UItHraJzXkrTEUSJBScsMQUOQeqUJeWRKRVSFb0UEHQRYSTC81YLRe0gIesQFjNTJVydCw5EKV2jiKkcYPY0qQSzWpWIGBMooEIYaTtpROZcheSyWg9mS7QpaKk60DI+UX7SxZItTCBJRkkkjk5PVYqJioqqsae0qoHkarGoVOq2y21jbUkUaAgABKwrUSm3Wjg81e5yzS2LYrDTkz5O59kR4/ElVUSXVQJFHrqdZVhDSBMk1lRQhbJlEMTEtIUNJhROuaNRITbo7GFChRUr/+5LE7QLZdgj4DCUgCxvBn1TCpEC3GlbQPZxHAqXhzDRVEMwlO2qOJSFbSHV19lBCVo+msjiq2m2hQyKk8EU9OZRZNlNl8KKbDGoKIJlDI6TrEzF2RICphcS3cyiBGm0kgUJYZqJchabZgkURMMuWVXePJRJS5ZVNlY0+1RohkjWSUQTi2jLLtvtbC8D5hmziMywQEBYkGuU2PDCyCIq9IMimZZMmiRtCs211IaG8J6Lzm2QxRyI5qykGUBGwgJg8sylZOJgTNuOlkxKUVUggvDZc2qiW6Sy5DCBZ8mk5bJImQKojqifTkZWXoktW10KM9bmsYQXNZtFisFIcink41cRTUUhE1BVK755+QtJJo2lqiSr0k6RrpX5qobNQIiPU05ES+2ufYNqLspHG09gyYnNCq9WcoobhBJCQqHh1mS6NIqonnlFlozG+5VTlZdA1HVVHvaJ18AkBEljcnsVg7NlqeMuNO3xNq1a1HRdBiKNkuOuyXVMZSMFHnZqn0O0Ms4tbKt/QnJJESGLxM8QEZ7Jr/DyaAyViktFBBJVpY+VG//uSxOoAWMIK+qeZJcsJwV9VhKQBw8oXX2Hf6DWdO13kZ1S0DLPWVibtco9FbQq5CUJYGULE0Ki66NNNF2ESNFkosuRrGSOCqJZWl0MiMobVQrTHyPVRlbGheaJsVZEQrY9U+2pIQiuIpaQGyEj71YwbTUgpqBNGw0RliK1jbaJcuSRUD5+BIUVtRfkic1LaPLpF2ysD6YZCsJuumNQPCcmmgbacveQiqIKEO1FEdISsThFTvMrIkoqhk0byRmIfXQKsJoIZvmchCiuESjbaz8QE/QwkKWVyQnkYlVrLlm1Uo6rJtEpEsTxRkiFJV0mXliU2eaTU8/As5HAjfWFA/Wl682YrdZYqq9zKyrLBMSqwLF8QswkwhLsMrJhr0ynoxEkZUSWcypJiWrlOeNGTlSnJaCBlWX7b3qNlegmrCT1EUGekckm2ZigUQsozC6JVk8YLRTIyZJNZAglZIGcgahpBEw5CmZEoSiN64gZSigQpRdeLRgk4nri0kWUZbbRQIEGGjTLpoVqemgJS5eE6JkMJIiJtCVfU5kEzdaOK80NpFf/7ksTsAVmmDPonsSvDBsFfVPMkqZBBIPjiI2MxFKV1F0DpmSYhJtrHstSHJwkSMLLZhhbS9QtJQjPj58jUguHi2nCi6VitleJdHJOSZAq2LJDRM9GKD6AaJyLvYbJXPbZhrbnJFUa6l3ZLZFFtWElB1H9Rq8LGok6EhD5/DiNffERlQwhgL9I/JAtS52bKqBSbkajGgBSi1SgjUWRIDxSesWyqHdk6svOXEiaeJIXXbDJAgSYRUek1JkNH7JGVCjhAQe1lyNW0Shg2imxJkNsmxgZcKkNQFTJAi4QKlY0sijkEUITMRhCSAsLY40ijI0hYKXCg2EnOUc5dYZJLZNydlM2tQWp7TSS8nXMnUbyb1xg1OntaOprIcwl+UZSlOQUEjjkdBiCUkIIhCROwpNGN+9dXh1oZ7IjEEw0vbA7cDR3mU7PfMR/TN1R2UUfJt6oV85mBjNWCmo4BwxcDWJ0LNGGgiNhdyEJJ1FRQhRlRCKMFArMoZkKytB48xEr0AZeOoXLBs5Eyy3PT6kPyHZtBFMlLmHsIDQpRk2nLXXqTGIb/+5LE6wAZJg74DBkjAuxBH+TEmfgkAfQD8Ia+KiA6lP7bR8pBOCYQYErQuIjEQy05YmeeTJUDYl0m1RgXxs6yfpUU8wVxc4+j8QZBpGJ4QRGGjKZklZKtlRNSJxhEuF2B9UmWUJ1kJOyXG5HhFonRqikSoh0oW01yUnTSWQNnVAJUaHUJJg65tYoUJiBUPxYGSVEiJogeoS3kXUTU6VbFw+Zo2sb8JXPrW9rQk8oo3rmuvZiQ5RRoKJQCCjiSRKXIonAIBAIKgk7EjiVkexJJ5BQnPWyRCYS8y+HEiSwXWBkiyM+plkqdFuaRROS/eacFRO2cOVWgoBgkAkvWznYkFJNXGCLYoWuqz4oYSrc/VZsQtEJKhZqREKoEQqJmtVd1hUKhU/3FCiIiaSLaRXJEKhUauOLIYLEQqaWJp3HFkV4REQpZjGiIVExEhzrCpqNNLNSlJMlI1UxBTUUzLjk5LjVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//uSxO8D2r4K9geZJ0r1QN2A8ybxVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==';

  // mutedUntil: 0 = not muted, -1 = muted until turned back on, >0 = muted until
  // that timestamp. Read fresh each time so a mute set in any tab is respected.
  function isMuted() {
    const mu = loadUi().mutedUntil || 0;
    return mu === -1 || (mu > 0 && Date.now() < mu);
  }
  function playAlert(volume) {
    if (volume <= 0 || isMuted()) return;
    const a = new Audio(ALERT_SOUND_DATA_URI);
    a.volume = volume;
    a.play().catch(() => {});
  }

  // Live panel volume, or the default before main() has loaded settings.
  function currentVolume() {
    return activeSettings ? activeSettings.soundVolume : CONFIG.soundVolume;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Same icon set as the panel's requirement rows. Only rendered for
  // requirements the study actually has (requirements[key] === true).
  const REQ_ICONS = {
    camera: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3"/></svg>',
    microphone: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    audio: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9v6h4l5 4V5L8 9H4zM17 9a4 4 0 0 1 0 6"/></svg>',
    install: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v11m0 0l-4-4m4 4l4-4M4 19h16"/></svg>',
  };
  function reqIconsHTML(requirements) {
    const icons = Object.keys(REQ_ICONS)
      .filter((key) => requirements && requirements[key] === true)
      .map((key) => REQ_ICONS[key])
      .join('');
    return icons ? `<span class="reqs">${icons}</span>` : '';
  }

  // ---- matches: docked, sortable, read-only list in the panel. Newest-first,
  // capped at 50, and shared across tabs. ----
  let matches = [];
  let earningsPrimed = false;       // refresh earnings once the auth token first becomes available
  let exporting = false;            // guards the on-demand CSV export (history fetch is heavy, so only ever runs on click)
  let selectedTaxYearStart = null;  // which UK tax year the Tax-year row shows (default = current)
  let selectedYearStart = null;     // which calendar year the Year row shows (default = current)
  let acceptedTodayCount = 0;       // submissions started today (from the earnings fetch); shown in the footer

  // ---- cross-tab coordination ----
  // Only one "leader" tab actually polls; every tab shares the matches list and
  // poll state through localStorage, so opening another Prolific tab (e.g. after
  // Reserve) doesn't double-poll, duplicate the alert, or reset the panel.
  const TAB_ID = Math.random().toString(36).slice(2) + '.' + Date.now();
  const LEADER_KEY = 'prolificAssist:leader';
  const MATCHES_KEY = 'prolificAssist:matches';
  const POLLSTATE_KEY = 'prolificAssist:pollstate';
  let liveKind = 'ok';

  function readStore(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  function heartbeat() {
    const l = readStore(LEADER_KEY);
    if (!l || (Date.now() - l.ts) > 8000 || l.id === TAB_ID) {
      try { localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, ts: Date.now() })); } catch {}
    }
  }
  function amLeader() { const l = readStore(LEADER_KEY); return !!(l && l.id === TAB_ID); }
  function loadMatchesStore() { const m = readStore(MATCHES_KEY); return Array.isArray(m) ? m : []; }
  function saveMatchesStore() { try { localStorage.setItem(MATCHES_KEY, JSON.stringify(matches.slice(0, 50))); } catch {} }
  function writePollState() {
    if (!amLeader()) return;
    try { localStorage.setItem(POLLSTATE_KEY, JSON.stringify({ nextAt: pollNextAt, intervalMs: pollIntervalMs, live: liveKind })); } catch {}
  }

  function isStudyPage() {
    // don't run on a study-taking tab (Reserve opens app.prolific.com/studies/<id>)
    try { return /\/studies\/[a-z0-9]{16,}/i.test(location.pathname) || /\/submissions\//i.test(location.pathname); } catch { return false; }
  }

  function updateShowMoreUI() {
    const root = document.getElementById('pa-root');
    const btn = document.getElementById('pa-showmore');
    if (!root || !btn) return;
    const total = matches.length;
    if (total <= 4) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.textContent = root.classList.contains('showall') ? 'Show fewer' : ('Show ' + (total - 4) + ' more');
  }

  // Read-only card: no Reserve/Dismiss - the script never acts on the account,
  // it only surfaces the study. The list self-manages (poll prunes filled ones).
  function matchCardHTML(study) {
    const title = escapeHtml(study.title || '');
    const reqs = reqIconsHTML(study.requirements);
    const mins = Number.isFinite(study.durationMin) ? `<span class="chip">${study.durationMin} min</span>` : '';
    const rate = Number.isFinite(study.hourlyRate) ? `<span class="chip rate">£${study.hourlyRate.toFixed(2)}/hr</span>` : '';
    const total = Number.isFinite(study.totalPay) ? `<span class="chip">£${study.totalPay.toFixed(2)}</span>` : '';
    const left = Number.isFinite(study.placesLeft)
      ? `<span class="chip${study.placesLeft <= 20 ? ' warn' : ''}">${study.placesLeft} left</span>`
      : '';
    const bonus = study.bonus ? `<span class="chip bonus">${escapeHtml(study.bonus)}</span>` : '';
    return `
      <div class="mcard">
        <div class="m-top"><span class="m-title"><a href="https://app.prolific.com/studies/${study.id}" target="_blank" rel="noopener noreferrer">${title}</a></span>${reqs}</div>
        <div class="m-meta">${mins}${rate}${total}${left}${bonus}</div>
      </div>
    `;
  }

  function renderMatches() {
    const mlist = document.getElementById('pa-mlist');
    if (!mlist) return; // panel not built yet

    const ui = loadUi();
    const sorted = matches.slice();
    if (ui.sort === 'rate') sorted.sort((a, b) => b.hourlyRate - a.hourlyRate);
    else if (ui.sort === 'total') sorted.sort((a, b) => b.totalPay - a.totalPay);
    else if (ui.sort === 'mins') sorted.sort((a, b) => a.durationMin - b.durationMin);
    else if (ui.sort === 'left') sorted.sort((a, b) => a.placesLeft - b.placesLeft);
    // 'newest' (default) keeps insertion order - matches is already newest-first.

    mlist.innerHTML = sorted.map((s) => matchCardHTML(s)).join('');
    const count = document.getElementById('pa-mcount');
    if (count) count.textContent = String(matches.length);
    const empty = document.getElementById('pa-empty');
    if (empty) empty.hidden = matches.length > 0;
    updateShowMoreUI();
  }

  // ---- auth capture: hooks fetch + XHR at document-start (see @run-at) so the
  // freshest Authorization / x-prolific-id / x-client-version headers from the app's
  // own calls to internal-api.prolific.com can be reused by the API client. Reads are
  // try/catch'd and always call through, so a hook failure can't break the page. ----
  const API_HOST = 'internal-api.prolific.com';

  function captureHeaderPair(name, value) {
    try {
      const key = String(name).toLowerCase();
      if (key === 'authorization') apiAuth = value;
      else if (key === 'x-prolific-id') apiProlificId = value;
      else if (key === 'x-client-version') apiClientVersion = value;
    } catch {}
  }

  // The app's own internal-api calls carry the participant id in the path
  // (…/users/<id>/…). Grab it so the balance endpoint uses the right id even when
  // the x-prolific-id header is absent or isn't the same value as the path id.
  function captureUrlId(url) {
    try {
      const id = parseUserId(url);
      if (id) apiUserId = id;
    } catch {}
  }

  function captureHeadersObject(headers) {
    try {
      if (!headers) return;
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((value, key) => captureHeaderPair(key, value));
      } else if (Array.isArray(headers)) {
        headers.forEach((pair) => captureHeaderPair(pair[0], pair[1]));
      } else {
        Object.keys(headers).forEach((key) => captureHeaderPair(key, headers[key]));
      }
    } catch {}
  }

  function installAuthCapture() {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (String(url).includes(API_HOST)) {
            captureUrlId(url);
            captureHeadersObject(init && init.headers);
            if (typeof Request !== 'undefined' && input instanceof Request) captureHeadersObject(input.headers);
          }
        } catch {}
        return origFetch.apply(this, arguments);
      };
    }

    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      const origOpen = OrigXHR.prototype.open;
      const origSetHeader = OrigXHR.prototype.setRequestHeader;
      OrigXHR.prototype.open = function (method, url) {
        try { this.__paUrl = url; if (String(url).includes(API_HOST)) captureUrlId(url); } catch {}
        return origOpen.apply(this, arguments);
      };
      OrigXHR.prototype.setRequestHeader = function (name, value) {
        try {
          if (this.__paUrl && String(this.__paUrl).includes(API_HOST)) captureHeaderPair(name, value);
        } catch {}
        return origSetHeader.apply(this, arguments);
      };
    }
  }

  // ---- API client: read-only. Polls for studies + earnings data (balance +
  // submissions history). No writes/reserves - keeps the account footprint low. ----
  const STUDIES_URL = 'https://internal-api.prolific.com/api/v1/participant/studies/?sortBy=published_at&orderBy=asc';
  const SUBMISSIONS_HISTORY_URL = 'https://internal-api.prolific.com/api/v1/participant/submissions/?ordering=-started_at&page_size=20';

  function apiHeaders() {
    return {
      Authorization: apiAuth,
      Accept: 'application/json',
      ...(apiClientVersion ? { 'x-client-version': apiClientVersion } : {}),
    };
  }

  const apiClient = {
    async fetchStudies() {
      if (!apiAuth) return [];
      const res = await fetch(STUDIES_URL, { headers: apiHeaders() });
      if (res.status === 401) throw new Error('unauthorized');
      const data = await res.json();
      return (data.results || []).map(normalizeStudy);
    },

    async fetchBalance() {
      const userId = apiUserId || apiProlificId;
      if (!apiAuth || !userId) return null;
      try {
        const res = await fetch(`https://internal-api.prolific.com/api/v1/users/${userId}/balance/`, { headers: apiHeaders() });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },

    // Pages newest-first, stopping once a page's oldest started_at predates
    // `sinceMs` (or there's no next page). Capped at 100 pages as a safety net.
    async fetchSubmissions(sinceMs) {
      const subs = [];
      let totalEarnedMinor = 0;
      let totalByCurrency = null;
      let url = SUBMISSIONS_HISTORY_URL;
      let page = 0;
      try {
        while (url && page < 100) {
          const res = await fetch(url, { headers: apiHeaders() });
          const data = await res.json();
          if (page === 0) {
            totalEarnedMinor = Number(data.meta && data.meta.total_earned) || 0;
            totalByCurrency = (data.meta && data.meta.total_earned_by_currency) || null;
          }
          let oldest = null;
          for (const raw of (data.results || [])) {
            subs.push(normalizeSubmission(raw));
            const started = raw.started_at ? Date.parse(raw.started_at) : null;
            if (started != null && (oldest == null || started < oldest)) oldest = started;
          }
          page++;
          const next = data._links && data._links.next && data._links.next.href;
          url = (oldest != null && oldest < sinceMs) ? null : (next || null);
        }
      } catch {}
      return { subs, totalEarnedMinor, totalByCurrency };
    },
  };

  // ---- earnings: balance + submissions history, rendered into the Earnings
  // tab and the footer. Guarded end-to-end so a network hiccup here can
  // never break polling or the rest of the panel. ----
  function setLive(kind) {
    liveKind = kind;
    const el = document.getElementById('pa-live');
    if (el) el.dataset.kind = kind;
    writePollState();
  }

  function setFooter(html, kind) {
    const el = document.getElementById('pa-footer');
    if (!el) return;
    const main = document.getElementById('pa-foot-main');
    if (main) main.innerHTML = html; else el.innerHTML = html;
    if (kind) el.dataset.kind = kind;
  }

  function gbp(minor) { return '£' + (minor / 100).toFixed(2); }

  function homeCurrency(bal) {
    return (bal && bal.estimated_total_balance && bal.estimated_total_balance.currency) || 'GBP';
  }
  // fx = { home, provider, table } for the currently-selected rate provider, with the
  // user's per-year overrides applied. Pass a settings-shaped object to force a
  // provider (the £1,000 flag forces HMRC); defaults to the live panel settings.
  function buildFx(bal, settings) {
    const s = settings || activeSettings || {};
    const provider = s.rateProvider || DEFAULT_PROVIDER;
    return { home: homeCurrency(bal), provider, table: providerTable(provider, s.rateOverrides) };
  }

  // Last fetched earnings, kept so switching rate provider (or editing a rate)
  // repaints from cache instead of re-polling the API.
  let lastEarnings = null; // { bal, subs, totalByCurrency, totalEarnedMinor, now }

  // Per-session cache of fetched submissions, keyed by the fetch's start ms. Lets a
  // past Year/Tax-year row (picked from its dropdown) recompute on a provider switch,
  // and a reselection of the same period reuse the data instead of re-hitting the API.
  const submissionsCache = new Map();
  async function subsSince(startMs) {
    if (submissionsCache.has(startMs)) return submissionsCache.get(startMs);
    const { subs } = await apiClient.fetchSubmissions(startMs);
    submissionsCache.set(startMs, subs);
    return subs;
  }
  // GBP-minor total over [startMs, endMs) from already-fetched subs, at the given fx.
  function periodTotalMinor(subs, startMs, endMs, fx) {
    let total = 0;
    for (const s of subs) {
      if (!s.countsToEarnings) continue;
      const t = s.completedAt != null ? s.completedAt : s.startedAt;
      if (t == null || t < startMs || t >= endMs) continue;
      total += submissionGBPminor(s, fx);
    }
    return total;
  }

  async function refreshEarnings() {
    try {
      const now = Date.now();
      const bal = await apiClient.fetchBalance();
      // Paint the balance the moment it lands - the submissions history below can be
      // many sequential pages, and available/pending shouldn't wait on it. Keep any
      // subs from the previous poll so the period rows don't flash to zero meanwhile.
      const prev = lastEarnings || { subs: [], totalByCurrency: null, totalEarnedMinor: 0 };
      lastEarnings = { ...prev, bal, now };
      paintEarnings();
      // fetch back to the earliest period we display (tax year is usually earliest)
      const since = Math.min(startOfMonth(now), startOfYear(now), startOfTaxYear(now));
      const { subs, totalEarnedMinor, totalByCurrency } = await apiClient.fetchSubmissions(since);
      lastEarnings = { bal, subs, totalByCurrency, totalEarnedMinor, now };
      paintEarnings();
    } catch {
      // an earnings hiccup should never break polling or the rest of the panel
    }
  }

  // UK trading allowance: the first £1,000 of miscellaneous/trading income per tax
  // year is tax-free and needs no Self Assessment. We watch it against the HMRC
  // total (the tax basis), whatever provider the display is set to.
  const TRADING_ALLOWANCE_MINOR = 100000;

  // Repaint the earnings rows from lastEarnings under the currently-selected provider.
  // Pure display - no network - so the provider toggle and rate edits call it directly.
  function paintEarnings() {
    if (!lastEarnings) return;
    const { bal, subs, totalByCurrency, totalEarnedMinor, now } = lastEarnings;
    const fx = buildFx(bal);
    const sum = earningsSummary(subs, fx, now);
    acceptedTodayCount = subs.filter((s) => s.startedAt != null && s.startedAt >= startOfDay(now)).length;
    const allTimeMinor = allTimeGBPminor(totalByCurrency, totalEarnedMinor, fx);
    const rateSuffix = sum.todayRateMinorPerHr != null ? `at ${gbp(sum.todayRateMinorPerHr)}/hr` : '';

    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    if (bal && bal.estimated_total_balance) setText('pa-e-available', gbp(bal.estimated_total_balance.amount));
    if (bal && bal.estimated_total_pending_balance) setText('pa-e-pending', gbp(bal.estimated_total_pending_balance.amount));
    setText('pa-e-today', gbp(sum.todayMinor)); // big amount stays right-aligned with the other rows
    const todayLbl = document.getElementById('pa-e-today-lbl'); // rate rides on the label instead
    if (todayLbl) todayLbl.innerHTML = 'Today' + (rateSuffix ? ` <small>${rateSuffix}</small>` : '');
    setText('pa-e-week', gbp(sum.weekMinor));
    setText('pa-e-month', gbp(sum.monthMinor));
    // Year / Tax-year rows: the current period comes from the live sum; a chosen past
    // period recomputes from its cached subs (so a provider switch updates it too, and
    // reselecting the same period never refetches). Labels track the selection.
    const curYearStart = startOfYear(now);
    if (selectedYearStart == null) selectedYearStart = curYearStart;
    const ylbl = document.getElementById('pa-e-year-lbl');
    if (ylbl) ylbl.textContent = yearLabel(selectedYearStart);
    if (selectedYearStart === curYearStart) setText('pa-e-year', gbp(sum.yearMinor));
    else if (submissionsCache.has(selectedYearStart)) setText('pa-e-year', gbp(periodTotalMinor(submissionsCache.get(selectedYearStart), selectedYearStart, yearEndMs(selectedYearStart), fx)));

    const curTaxStart = startOfTaxYear(now);
    if (selectedTaxYearStart == null) selectedTaxYearStart = curTaxStart;
    const tlbl = document.getElementById('pa-e-taxyear-lbl');
    if (tlbl) tlbl.textContent = taxYearLabel(selectedTaxYearStart);
    if (selectedTaxYearStart === curTaxStart) setText('pa-e-taxyear', gbp(sum.taxYearMinor));
    else if (submissionsCache.has(selectedTaxYearStart)) setText('pa-e-taxyear', gbp(periodTotalMinor(submissionsCache.get(selectedTaxYearStart), selectedTaxYearStart, taxYearEndMs(selectedTaxYearStart), fx)));
    setText('pa-e-alltime', gbp(allTimeMinor));

    // £1,000 allowance gauge - always the HMRC current-tax-year total, regardless of
    // the display provider, since that's the figure HMRC counts.
    const alEl = document.getElementById('pa-allowance');
    if (alEl) {
      const hmrcFx = buildFx(bal, { rateProvider: 'HMRC', rateOverrides: (activeSettings || {}).rateOverrides });
      const hmrcTax = earningsSummary(subs, hmrcFx, now).taxYearMinor;
      const over = hmrcTax >= TRADING_ALLOWANCE_MINOR;
      alEl.textContent = over
        ? `Over £1,000 allowance (${gbp(hmrcTax)}) - Self Assessment may apply`
        : `${gbp(hmrcTax)} of £1,000 tax-free allowance`;
      alEl.className = 'allowance' + (over ? ' over' : hmrcTax >= 0.8 * TRADING_ALLOWANCE_MINOR ? ' near' : '');
    }

    setFooter('Today ' + gbp(sum.todayMinor) + (rateSuffix ? ` <small>${rateSuffix}</small>` : ''), 'ok');
    updateStats();
  }

  function periodStart(period, now) {
    if (period === 'today') return startOfDay(now);
    if (period === 'week') return startOfWeek(now);
    if (period === 'month') return startOfMonth(now);
    if (period === 'year') return startOfYear(now);
    if (period === 'taxyear') return startOfTaxYear(now);
    return -Infinity; // 'all'
  }

  // [since, until, filenameLabel] for the simple export presets. The Year / Tax
  // year presets are handled in buildPanel (they read the export menu's own
  // year pickers), so they never reach here.
  function exportBounds(period) {
    return [periodStart(period, Date.now()), Infinity, period];
  }

  // UK tax-year helpers for the selectable Tax-year row. A tax year starts Apr 6
  // of year Y and ends the following Apr 6 (exclusive); labelled "Y/Y+1".
  function taxYearEndMs(startMs) { return new Date(new Date(startMs).getFullYear() + 1, 3, 6).getTime(); }
  function taxYearLabel(startMs) { const y = new Date(startMs).getFullYear(); return y + '/' + String((y + 1) % 100).padStart(2, '0'); }
  function taxYearStarts(nowMs, count) {
    const curY = new Date(startOfTaxYear(nowMs)).getFullYear();
    const out = [];
    for (let i = 0; i < count; i++) out.push(new Date(curY - i, 3, 6).getTime());
    return out;
  }

  // Calendar-year counterparts for the selectable "Year" row (Jan 1 -> next Jan 1).
  function yearEndMs(startMs) { return new Date(new Date(startMs).getFullYear() + 1, 0, 1).getTime(); }
  function yearLabel(startMs) { return String(new Date(startMs).getFullYear()); }
  function yearStarts(nowMs, count) {
    const curY = new Date(nowMs).getFullYear();
    const out = [];
    for (let i = 0; i < count; i++) out.push(new Date(curY - i, 0, 1).getTime());
    return out;
  }

  // Fill a selectable earnings row (Tax-year or Year) for a chosen past period. The
  // dropdown handler has already set the selection; here we just make sure that
  // period's subs are cached (fetch once, reuse thereafter) and repaint. paintEarnings
  // does the actual conversion, so the row always reflects the current provider.
  async function showPeriod(startMs, valId) {
    if (!submissionsCache.has(startMs)) {
      const val = document.getElementById(valId);
      if (val) val.textContent = '...';
      try { await subsSince(startMs); }
      catch { if (val) val.textContent = '-'; return; }
    }
    paintEarnings();
  }
  const showTaxYear = (startMs) => showPeriod(startMs, 'pa-e-taxyear');
  const showYear = (startMs) => showPeriod(startMs, 'pa-e-year');

  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // On-demand only (never auto-run): fetches just the pages needed to reach
  // sinceMs, showing progress on the button, filters to [sinceMs, untilMs], then
  // downloads. Heavy for 'all', so it only runs when the user asks for it.
  async function exportRange(sinceMs, untilMs, label) {
    if (exporting) return;
    exporting = true;
    const btn = document.getElementById('pa-export');
    // the history fetch length is unpredictable, so show an indeterminate spinner
    // rather than a misleading % / progress bar that's always off.
    if (btn) btn.innerHTML = '<span class="spin"></span>Exporting';
    try {
      const fx = buildFx(await apiClient.fetchBalance());
      const subs = [];
      let url = SUBMISSIONS_HISTORY_URL, page = 0;
      while (url && page < 200) {
        const res = await fetch(url, { headers: apiHeaders() });
        const data = await res.json();
        let oldest = null;
        for (const raw of (data.results || [])) {
          subs.push(normalizeSubmission(raw));
          const st = raw.started_at ? Date.parse(raw.started_at) : null;
          if (st != null && (oldest == null || st < oldest)) oldest = st;
        }
        page++;
        const next = data._links && data._links.next && data._links.next.href;
        url = (oldest != null && oldest < sinceMs) ? null : (next || null);
      }
      const rows = [['date', 'study', 'status', 'currency', 'reward', 'bonus', 'minutes', 'gbp_per_hour']];
      for (const s of subs) {
        const ms = s.completedAt != null ? s.completedAt : s.startedAt;
        if (ms == null || ms < sinceMs || ms > untilMs) continue;
        const perHour = s.timeTakenSec > 0 ? (submissionGBPminor(s, fx) / 100 / (s.timeTakenSec / 3600)).toFixed(2) : '';
        rows.push([new Date(ms).toISOString(), s.studyName, s.status, s.currency, (s.rewardMinor / 100).toFixed(2), (s.bonusMinor / 100).toFixed(2), s.timeTakenSec ? (s.timeTakenSec / 60).toFixed(1) : '', perHour]);
      }
      const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
      const dl = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = dl; a.download = 'prolific-earnings-' + (label || 'export') + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(dl), 2000);
      if (btn) btn.textContent = 'Export CSV';
    } catch {
      if (btn) btn.textContent = 'Export failed - retry';
    } finally {
      exporting = false;
    }
  }

  // ---- polling loop (read-only: fetches studies, never acts on the account) ----
  async function poll(settings) {
    let studies;
    try {
      studies = await apiClient.fetchStudies();
    } catch {
      setLive('warn');
      return;
    }

    if (studies.length === 0 && !apiAuth) {
      setLive('warn');
      return;
    }

    // the list mirrors what's currently available: drop matches that have filled
    // or expired (no longer in the feed), and add any new ones
    const currentIds = new Set(studies.map((s) => s.id));
    matches = matches.filter((m) => currentIds.has(m.id));
    for (const study of studies) {
      if (!matcher(study, settings)) continue;
      if (!matches.some((m) => m.id === study.id)) matches.unshift(study);
      if (!isSeen(study.id)) { markSeen(study.id); bumpSeenToday(); playAlert(currentVolume()); } // alert + count once per study
    }
    if (matches.length > 50) matches.length = 50;
    saveMatchesStore();
    renderMatches();
    updateStats();
    setLive('ok');
    // populate earnings/footer as soon as a working token exists, rather than
    // waiting up to 5 min for the refresh interval or an Earnings-tab open
    if (!earningsPrimed) { earningsPrimed = true; refreshEarnings(); }
  }

  function runLoop(settings) {
    pollIntervalMs = settings.pollIntervalSec * 1000;
    heartbeat();
    setInterval(heartbeat, 3000); // keep/steal the leader lock independently of the poll interval
    const tick = () => {
      if (!amLeader()) return; // followers render the shared state; only the leader fetches
      pollNextAt = Date.now() + pollIntervalMs;
      writePollState();
      poll(settings);
    };
    let timer = setInterval(tick, pollIntervalMs);
    tick();
    return {
      reschedule() {
        clearInterval(timer);
        pollIntervalMs = settings.pollIntervalSec * 1000;
        timer = setInterval(tick, pollIntervalMs);
      },
    };
  }

  // ---- browser entry (inert under Node) ----
  function main() {
    if (isStudyPage()) return; // no panel or polling on a study-taking tab
    installAuthCapture();
    const start = () => {
      activeSettings = loadSettings();
      matches = loadMatchesStore(); // pick up matches other tabs already found, instead of resetting
      const ps = readStore(POLLSTATE_KEY);
      if (ps) { pollNextAt = ps.nextAt || 0; if (ps.intervalMs) pollIntervalMs = ps.intervalMs; if (ps.live) liveKind = ps.live; }
      const loop = runLoop(activeSettings);
      buildPanel(activeSettings, () => { saveSettings(activeSettings); loop.reschedule(); });
      refreshEarnings();
      setInterval(refreshEarnings, 300000);
      // stay in sync with the leader tab: another tab updating matches/poll-state re-renders here
      window.addEventListener('storage', (e) => {
        if (e.key === MATCHES_KEY) { matches = loadMatchesStore(); renderMatches(); }
        else if (e.key === POLLSTATE_KEY) {
          const s = readStore(POLLSTATE_KEY);
          if (s) {
            if (s.nextAt) pollNextAt = s.nextAt;
            if (s.intervalMs) pollIntervalMs = s.intervalMs;
            if (s.live) { liveKind = s.live; const el = document.getElementById('pa-live'); if (el) el.dataset.kind = s.live; }
          }
        }
      });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  }

  if (typeof document !== 'undefined') main();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      defaultSettings, parseKeywords, parseUserId, matcher, normalizeStudy,
      parseBonus, normalizeSubmission, providerTable, rateFor, toGBPminor, submissionGBPminor, allTimeGBPminor, earningsSummary,
    };
  }
})();
