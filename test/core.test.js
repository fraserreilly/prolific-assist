const { test } = require('node:test');
const assert = require('node:assert');
const { defaultSettings, parseKeywords } = require('../assist.user.js');

test('defaultSettings shape', () => {
  const s = defaultSettings();
  assert.strictEqual(s.minHourly, null);
  assert.strictEqual(s.minTotal, null);
  assert.deepStrictEqual(s.includeKeywords, []);
  assert.deepStrictEqual(s.excludeKeywords, []);
  assert.deepStrictEqual(s.requirements, {
    camera: 'ignore', microphone: 'ignore', audio: 'ignore', install: 'ignore',
  });
  assert.strictEqual(s.pollIntervalSec, 30);
  assert.strictEqual(s.soundVolume, 0.7);
});

test('parseKeywords trims and drops empties', () => {
  assert.deepStrictEqual(parseKeywords(' survey , ,interview,'), ['survey', 'interview']);
  assert.deepStrictEqual(parseKeywords(''), []);
});

const { parseUserId } = require('../assist.user.js');

test('parseUserId: pulls the id from a /users/<id>/ path, ignores non-ids', () => {
  assert.strictEqual(parseUserId('https://internal-api.prolific.com/api/v1/users/5bd6f5a1e2c4a30001a2b3c4/balance/'), '5bd6f5a1e2c4a30001a2b3c4');
  assert.strictEqual(parseUserId('/api/v1/users/5bd6f5a1e2c4a30001a2b3c4/submissions/?page=2'), '5bd6f5a1e2c4a30001a2b3c4');
  assert.strictEqual(parseUserId('/api/v1/studies/?users=xyz'), null); // not a /users/<id>/ segment
  assert.strictEqual(parseUserId(''), null);
});

const { matcher } = require('../assist.user.js');

const study = (over = {}) => ({
  id: 's1', title: 'Example survey', totalPay: 2.5, hourlyRate: 12.5, durationMin: 12,
  requirements: { camera: false, microphone: false, audio: false, install: false },
  ...over,
});
const base = () => require('../assist.user.js').defaultSettings();

test('passes with default (no filters)', () => {
  assert.strictEqual(matcher(study(), base()), true);
});

test('min hourly gate', () => {
  const s = { ...base(), minHourly: 13 };
  assert.strictEqual(matcher(study({ hourlyRate: 12.5 }), s), false);
  assert.strictEqual(matcher(study({ hourlyRate: 13 }), s), true);
});

test('min total gate', () => {
  const s = { ...base(), minTotal: 3 };
  assert.strictEqual(matcher(study({ totalPay: 2.5 }), s), false);
  assert.strictEqual(matcher(study({ totalPay: 3 }), s), true);
});

test('null thresholds are off', () => {
  assert.strictEqual(matcher(study({ hourlyRate: 0, totalPay: 0 }), base()), true);
});

test('include keywords: match any, case-insensitive', () => {
  const s = { ...base(), includeKeywords: ['interview', 'SURVEY'] };
  assert.strictEqual(matcher(study({ title: 'Quick survey' }), s), true);
  assert.strictEqual(matcher(study({ title: 'A game' }), s), false);
});

test('exclude keywords skip', () => {
  const s = { ...base(), excludeKeywords: ['pilot'] };
  assert.strictEqual(matcher(study({ title: 'Pilot study' }), s), false);
});

test('requirement require: study must have it', () => {
  const s = { ...base(), requirements: { ...base().requirements, camera: 'require' } };
  assert.strictEqual(matcher(study({ requirements: { camera: false, microphone: false, audio: false, install: false } }), s), false);
  assert.strictEqual(matcher(study({ requirements: { camera: true, microphone: false, audio: false, install: false } }), s), true);
});

test('requirement hide: study must lack it', () => {
  const s = { ...base(), requirements: { ...base().requirements, microphone: 'hide' } };
  assert.strictEqual(matcher(study({ requirements: { camera: false, microphone: true, audio: false, install: false } }), s), false);
});

const { normalizeStudy } = require('../assist.user.js');

test('normalizeStudy: maps money/places and a microphone requirement (sub-penny reward)', () => {
  const n = normalizeStudy({
    id: 'study-a',
    name: 'Example Product Survey',
    reward: 364.96, // minor units carry sub-penny precision
    estimated_reward_per_hour: 1095,
    estimated_completion_time: 20,
    total_available_places: 600,
    places_taken: 468,
    peripheral_requirements: ['microphone'],
    external_app: null,
  });
  assert.strictEqual(n.id, 'study-a');
  assert.strictEqual(n.title, 'Example Product Survey');
  assert.ok(Math.abs(n.totalPay - 3.6496) < 1e-6);
  assert.ok(Math.abs(n.hourlyRate - 10.95) < 1e-6);
  assert.strictEqual(n.durationMin, 20);
  assert.strictEqual(n.placesLeft, 132);
  assert.deepStrictEqual(n.requirements, { camera: false, microphone: true, audio: false, install: false });
});

test('normalizeStudy: no requirements, small reward', () => {
  const n = normalizeStudy({
    id: 'study-b',
    name: 'Example Short Study',
    reward: 60.0,
    estimated_reward_per_hour: 900,
    estimated_completion_time: 4,
    total_available_places: 310,
    places_taken: 306,
    peripheral_requirements: [],
    external_app: null,
  });
  assert.strictEqual(n.id, 'study-b');
  assert.ok(Math.abs(n.totalPay - 0.6) < 1e-6);
  assert.ok(Math.abs(n.hourlyRate - 9) < 1e-6);
  assert.strictEqual(n.durationMin, 4);
  assert.strictEqual(n.placesLeft, 4);
  assert.deepStrictEqual(n.requirements, { camera: false, microphone: false, audio: false, install: false });
});

test('normalizeStudy: download study -> install requirement', () => {
  const n = normalizeStudy({
    id: 'study-c',
    name: 'Example App Test',
    reward: 134.3,
    estimated_reward_per_hour: 1343,
    estimated_completion_time: 6,
    total_available_places: 20,
    places_taken: 10,
    peripheral_requirements: ['download'],
    external_app: null,
  });
  assert.strictEqual(n.placesLeft, 10);
  assert.deepStrictEqual(n.requirements, { camera: false, microphone: false, audio: false, install: true });
});

const { parseBonus, normalizeSubmission, providerTable, rateFor, toGBPminor, allTimeGBPminor, earningsSummary } = require('../assist.user.js');

// A hand-built provider table (fx.table), independent of the production rates, so
// these tests exercise the conversion logic rather than the specific numbers.
const USDFX = { home: 'GBP', table: { USD: { 2024: 0.78, 2025: 0.76, 2026: 0.74 } } };

test('toGBPminor: converts at the rate for the year the money was earned', () => {
  assert.strictEqual(toGBPminor(1000, 'USD', USDFX, new Date('2024-06-01T12:00:00Z').getTime()), Math.round(1000 * 0.78));
  assert.strictEqual(toGBPminor(1000, 'USD', USDFX, new Date('2025-06-01T12:00:00Z').getTime()), Math.round(1000 * 0.76));
});

test('toGBPminor: a year outside the table clamps to the nearest year present', () => {
  assert.strictEqual(toGBPminor(1000, 'USD', USDFX, new Date('2019-01-01T12:00:00Z').getTime()), Math.round(1000 * 0.78)); // -> 2024
  assert.strictEqual(toGBPminor(1000, 'USD', USDFX, new Date('2031-01-01T12:00:00Z').getTime()), Math.round(1000 * 0.74)); // -> 2026
});

test('toGBPminor: dateless uses the latest year (all-time lump); home is 1:1', () => {
  assert.strictEqual(toGBPminor(1000, 'USD', USDFX), Math.round(1000 * 0.74)); // latest = 2026
  assert.strictEqual(toGBPminor(1234, 'GBP', USDFX), 1234);
});

test('rateFor: unknown currency and missing fx are 1:1', () => {
  assert.strictEqual(rateFor('EUR', Date.now(), USDFX), 1); // no EUR table
  assert.strictEqual(rateFor('USD', Date.now(), null), 1);
});

test('per-period USD converts via the selected provider table', () => {
  const now = new Date('2026-07-21T12:00:00Z').getTime();
  const usd = { countsToEarnings: true, completedAt: now, startedAt: now, timeTakenSec: 600, currency: 'USD', rewardMinor: 500, bonusMinor: 0, extrasMinor: 0 };
  assert.strictEqual(earningsSummary([usd], USDFX, now).todayMinor, Math.round(500 * 0.74)); // 2026 rate
});

test('parseBonus: common phrasings', () => {
  assert.strictEqual(parseBonus('you will receive up to £2 bonus for good work'), 'up to £2 bonus');
  assert.strictEqual(parseBonus('1 in 5 participants receive a bonus'), '1 in 5 bonus');
  assert.strictEqual(parseBonus('there is a £3 bonus for finishing'), '£3 bonus');
  assert.strictEqual(parseBonus('we offer a bonus of $5 to top performers'), '$5 bonus');
  assert.strictEqual(parseBonus('complete for a chance at a bonus'), 'bonus available');
  assert.strictEqual(parseBonus('<p>Get up to £4 bonus!</p>'), 'up to £4 bonus');
  assert.strictEqual(parseBonus('a regular study with no extras'), null);
});

test('normalizeSubmission: APPROVED sample counts toward earnings', () => {
  const n = normalizeSubmission({
    id: 'sub-1', status: 'APPROVED',
    started_at: '2026-05-10T10:00:00.000Z', completed_at: '2026-05-10T10:05:00.000Z',
    time_taken: '301.898',
    study: { id: 'study-x', name: 'Example Study' },
    submission_reward: { amount: 34, currency: 'USD' },
    submission_bonuses: [], submission_adjustments: [], screened_out_payments: [],
  });
  assert.strictEqual(n.status, 'APPROVED');
  assert.strictEqual(n.countsToEarnings, true);
  assert.strictEqual(n.currency, 'USD');
  assert.strictEqual(n.rewardMinor, 34);
  assert.strictEqual(n.bonusMinor, 0);
  assert.ok(Math.abs(n.timeTakenSec - 301.898) < 1e-6);
  assert.strictEqual(n.studyName, 'Example Study');
});

test('normalizeSubmission: RETURNED does not count', () => {
  const n = normalizeSubmission({ status: 'RETURNED', submission_reward: { amount: 500, currency: 'USD' }, study: {} });
  assert.strictEqual(n.countsToEarnings, false);
});

test('normalizeSubmission: screened-out fee counts (fee only, any status string)', () => {
  const n = normalizeSubmission({
    status: 'SCREENED OUT', study: { id: 's', name: 'Screener' },
    started_at: '2026-07-20T10:00:00Z', completed_at: null,
    submission_reward: { amount: 0, currency: 'GBP' }, // no reward, only the fee
    submission_bonuses: [], submission_adjustments: [],
    screened_out_payments: [{ amount: 10, currency: 'GBP' }],
  });
  assert.strictEqual(n.countsToEarnings, true);
  assert.strictEqual(n.rewardMinor, 0);
  assert.strictEqual(n.extrasMinor, 10);
  const s = earningsSummary([n], { home: 'GBP', rates: { GBP: 1 } }, new Date('2026-07-21T12:00:00Z').getTime());
  assert.strictEqual(s.taxYearMinor, 10); // only the £0.10 fee
});

test('providerTable: built-in rates plus user overrides', () => {
  assert.strictEqual(providerTable('HMRC').USD[2025], 0.7601);   // official HMRC yearly average
  assert.strictEqual(providerTable('ECB').USD[2026], 0.7438);    // ECB mid-market YTD
  assert.strictEqual(providerTable('PayPal').USD[2026], 0.719);  // calibrated from a real withdrawal
  const t = providerTable('HMRC', { HMRC: { USD: { 2025: 0.80 } } });
  assert.strictEqual(t.USD[2025], 0.80);    // override wins
  assert.strictEqual(t.USD[2024], 0.7820);  // base untouched
});

test('earningsSummary: periods + worked-time rate', () => {
  const now = Date.now(), day = 86400000;
  const fx = { home: 'GBP', rates: { GBP: 1 } };
  const subs = [
    { countsToEarnings: true, completedAt: now, startedAt: now - 3600000, timeTakenSec: 3600, currency: 'GBP', rewardMinor: 500, bonusMinor: 0, extrasMinor: 0 },
    { countsToEarnings: true, completedAt: now, startedAt: now - 1800000, timeTakenSec: 1800, currency: 'GBP', rewardMinor: 250, bonusMinor: 0, extrasMinor: 0 },
    { countsToEarnings: false, completedAt: now, timeTakenSec: 9999, currency: 'GBP', rewardMinor: 999, bonusMinor: 0, extrasMinor: 0 },
    { countsToEarnings: true, completedAt: now - 40 * day, startedAt: now - 40 * day, timeTakenSec: 600, currency: 'GBP', rewardMinor: 1000, bonusMinor: 0, extrasMinor: 0 },
  ];
  const s = earningsSummary(subs, fx, now);
  assert.strictEqual(s.todayMinor, 750);
  assert.strictEqual(s.todayWorkedSec, 5400);
  assert.strictEqual(s.todayRateMinorPerHr, 500);
  assert.strictEqual(s.weekMinor, 750);   // 40-days-ago excluded
  assert.strictEqual(s.monthMinor, 750);
  assert.ok(s.yearMinor >= 750);          // year + tax-year always include today's
  assert.ok(s.taxYearMinor >= 750);
});

test('earningsSummary: tax year (Apr 6) excludes pre-April earnings that calendar year includes', () => {
  const now = new Date('2026-07-21T12:00:00Z').getTime();
  const fx = { home: 'GBP', rates: { GBP: 1 } };
  const feb = new Date('2026-02-15T12:00:00Z').getTime(); // in calendar year, before tax year
  const may = new Date('2026-05-10T12:00:00Z').getTime(); // in both
  const subs = [
    { countsToEarnings: true, completedAt: feb, startedAt: feb, timeTakenSec: 600, currency: 'GBP', rewardMinor: 1000, bonusMinor: 0, extrasMinor: 0 },
    { countsToEarnings: true, completedAt: may, startedAt: may, timeTakenSec: 600, currency: 'GBP', rewardMinor: 500, bonusMinor: 0, extrasMinor: 0 },
  ];
  const s = earningsSummary(subs, fx, now);
  assert.strictEqual(s.yearMinor, 1500);   // Feb + May
  assert.strictEqual(s.taxYearMinor, 500); // only May counts in the 2026/27 tax year
});

const { filterFeed } = require('../assist.user.js');

test('filterFeed: keeps only passing studies, newest-first, and counts the hidden', () => {
  // feed is published_at ascending; s3 is newest. minHourly hides s2.
  const s1 = study({ id: 's1', hourlyRate: 20 });
  const s2 = study({ id: 's2', hourlyRate: 5 });
  const s3 = study({ id: 's3', hourlyRate: 15 });
  const r = filterFeed([s1, s2, s3], { ...base(), minHourly: 10 });
  assert.deepStrictEqual(r.shown.map((s) => s.id), ['s3', 's1']); // reversed to newest-first, s2 excluded
  assert.strictEqual(r.hidden, 1);
});

test('filterFeed: no filters shows all, hides none; empty feed is empty', () => {
  const feed = [study({ id: 'a' }), study({ id: 'b' })];
  const r = filterFeed(feed, base());
  assert.deepStrictEqual(r.shown.map((s) => s.id), ['b', 'a']);
  assert.strictEqual(r.hidden, 0);
  const e = filterFeed([], base());
  assert.deepStrictEqual(e.shown, []);
  assert.strictEqual(e.hidden, 0);
});

test('earningsSummary: no worked time -> null rate', () => {
  const now = Date.now();
  const s = earningsSummary(
    [{ countsToEarnings: true, completedAt: now, timeTakenSec: 0, currency: 'GBP', rewardMinor: 100, bonusMinor: 0, extrasMinor: 0 }],
    { home: 'GBP', rates: { GBP: 1 } }, now);
  assert.strictEqual(s.todayRateMinorPerHr, null);
});
