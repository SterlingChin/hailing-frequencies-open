const DAY = 86400000;
const compact = (value, limit) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
};
export function relativeTime(value, now) {
  const days = Math.floor((new Date(now) - new Date(value)) / DAY);
  if (days < 0) return 'in the future';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  return `${Math.floor(days / 7)} weeks ago`;
}
function etaText(eta, now) {
  const days = Math.floor(new Date(eta) / DAY) - Math.floor(new Date(now) / DAY);
  return days === 1 ? 'tomorrow' : days === 0 ? 'today' : new Date(eta).toISOString().slice(0, 10);
}

/** Fixed field budgets preserve all categories even for long stored content. */
export function buildCaseBrief({ caseRecord: c, tasks = [], parts = [], messages = [] }, now = new Date()) {
  const pending = tasks.filter(t => t.status === 'working');
  const latestPart = [...parts].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))[0];
  const latestMessage = [...messages].sort((a, b) => b.requested_at.localeCompare(a.requested_at) || a.id.localeCompare(b.id))[0];
  const part = latestPart ? `${compact(latestPart.part_name, 36)}: ${latestPart.status}` +
    (latestPart.status === 'shipped' ? ` via ${compact(latestPart.carrier, 28)}; ETA ${etaText(latestPart.eta, now)}` : '') +
    (parts.length > 1 ? ` (${parts.length} orders)` : '') : 'none';
  return [
    `${c.id} (${c.status}); opened ${relativeTime(c.opened_at, now)}; touched ${relativeTime(c.updated_at, now)}.`,
    `Symptom: ${compact(c.symptom, 85)}.`,
    `Diagnosis (${c.diagnosis_status}): ${compact(c.diagnosis || 'none', 70)}.`,
    `Next: ${compact(c.next_step || 'not recorded', 65)}.`,
    `Pending: ${pending.length ? `${pending.length} (${[...new Set(pending.map(t => t.specialist))].join(', ')})` : 'none'}.`,
    `Part: ${part}.`,
    `Last SMS: ${latestMessage?.status ?? 'none'}.`,
  ].join(' ').slice(0, 600);
}
