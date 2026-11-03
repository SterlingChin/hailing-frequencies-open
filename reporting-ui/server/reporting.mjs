import { randomUUID } from 'node:crypto';

export const CREW = Object.freeze({ id: 'demo-avery-chen', name: 'Avery Chen', rank: 'Commander', ship: 'USS Wayfinder', registry: 'NCC-74602', demo: true });
export const PHRASE = 'Authorization, Chen, Avery. Alpha seven, Bravo nine, Echo two';
export const GREETING = 'Hailing frequencies open. Please state your name and authorization phrase.';

export function createInteraction() {
  return { authorized: false, attempts: 0, report: null, mode: 'live', active: false, liveStatus: 'idle' };
}

function normalize(value) {
  if (typeof value !== 'string' || value.length > 500) return '';
  const digits = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', alpha: 'a', beta: 'b', bravo: 'b', echo: 'e' };
  return value.toLowerCase().replace(/\bauthorization\b/g, '').replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|alpha|beta|bravo|echo)\b/g, word => digits[word]).replace(/[^a-z0-9]/g, '');
}

export function confirmIdentity(state, phrase) {
  if (state.authorized) return { ok: true, status: 'profile_loaded', crew: CREW };
  if (state.attempts >= 3) return { ok: false, error: 'locked', remaining: 0 };
  state.attempts++;
  if (normalize(phrase) !== normalize(PHRASE)) return { ok: false, error: 'phrase_mismatch', remaining: 3 - state.attempts };
  state.authorized = true; state.profile = CREW;
  return { ok: true, status: 'profile_loaded', crew: CREW };
}

function cleanText(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }

export function captureReport(state, { issue, location = '' } = {}) {
  if (!state.authorized) return { ok: false, error: 'identity_required' };
  const text = cleanText(issue, 6000);
  if (!text) return { ok: false, error: 'issue_required' };
  state.report = {
    id: state.report?.id ?? `HF-${randomUUID().slice(0, 8).toUpperCase()}`,
    revision: randomUUID(),
    createdAt: state.report?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(), crew: state.profile,
    issue: text, location: cleanText(location, 200), delivery: 'not_sent',
    reviewed: false, mode: state.mode,
  };
  return { ok: true, report: state.report };
}

export function editReport(state, args) {
  if (!state.report) return { ok: false, error: 'report_required' };
  const issue = cleanText(args.issue, 6000);
  if (!issue) return { ok: false, error: 'issue_required' };
  state.report = { ...state.report, issue, location: cleanText(args.location ?? '', 200),
    updatedAt: new Date().toISOString(), reviewed: true };
  return { ok: true, report: state.report };
}
