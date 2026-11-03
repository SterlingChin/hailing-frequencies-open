// The context bundle is the single text input the decision step sees. It is
// built only from safeProfile output (no phone numbers, no authorization
// hashes), the selected case brief, and what the caller said. Fixed budgets
// keep it small enough to send on every turn.
import { relativeTime } from '../crm/brief.mjs';

const E164 = /\+[1-9]\d{6,14}/g;
const compact = (value, limit) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').replace(E164, '[number withheld]').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
};

export function buildContextBundle({ profile = null, caseBrief = null, request, channel = 'voice', now = new Date() }) {
  if (typeof request !== 'string' || !request.trim()) throw new Error('request_required');
  if (!['voice', 'sms'].includes(channel)) throw new Error('invalid_channel');
  const lines = [`Channel: ${channel}.`];
  if (profile) {
    const role = [profile.department && compact(profile.department, 20), profile.section && compact(profile.section, 40)].filter(Boolean).join(' / ');
    lines.push(`Caller: ${compact(profile.rank, 30)} ${compact(profile.display_name, 40)}, ${compact(profile.ship, 40)}` +
      (role ? `; ${role}` : '') + (profile.clearance_level ? `; clearance level ${profile.clearance_level}` : '') +
      (profile.posting ? `; posted ${compact(profile.posting, 50)}` : '') + (profile.status && profile.status !== 'active' ? `; status ${profile.status}` : '') +
      `; preferred spoken language ${compact(profile.preferred_language ?? 'english', 20)}.`);
    lines.push(profile.last_contact
      ? `Last contact: ${relativeTime(profile.last_contact.at, now)} by ${profile.last_contact.channel}${profile.last_contact.case_id ? ` about ${profile.last_contact.case_id}` : ''}; ${profile.contact_count ?? 1} prior contact(s).`
      : 'Last contact: none on record; first contact.');
    const equipment = Array.isArray(profile.equipment) ? profile.equipment : [];
    lines.push(equipment.length
      ? `Equipment: ${equipment.slice(0, 5).map(e => `${compact(e.model, 20)} at ${compact(e.location, 40)}${e.last_service_note ? ` (last service: ${compact(e.last_service_note, 60)})` : ''}`).join('; ')}.`
      : 'Equipment: none on record.');
    const open = Array.isArray(profile.open_cases) ? profile.open_cases : [];
    lines.push(open.length ? `Open cases: ${open.slice(0, 3).map(c => compact(c.brief, 240)).join(' | ')}` : 'Open cases: none.');
  } else lines.push('Caller: not identified. No profile loaded.');
  if (caseBrief) lines.push(`Selected case: ${compact(caseBrief, 600)}`);
  lines.push(`Request: ${compact(request, 500)}`);
  return { text: lines.join('\n'), identified: Boolean(profile), hasSelectedCase: Boolean(caseBrief) };
}
