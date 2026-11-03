// A fictional crew roster for demos and tests. Every phrase, number and
// service number here is invented. Phones use the reserved 555-01xx range.
// Authorization phrases use only digits plus A and B so they can be spoken
// ("two seven alpha four beta one") and normalise to the same hash.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashAuthCode } from './service.mjs';
import { PostgresRepository } from './repo-postgres.mjs';
import { readLocalEnv, requireConfirmedDatabase } from './env.mjs';

export const DEPARTMENTS = Object.freeze(['command', 'operations', 'engineering', 'sciences', 'security', 'medical']);
const id = n => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

export const ROSTER = Object.freeze([
  { id: id(1), display_name: 'Tavi Rourke', rank: 'Lieutenant', ship: 'USS Wayfinder', department: 'sciences', section: 'Astrophysics',
    clearance_level: 5, posting: 'Deck 11, Astrophysics Lab 2', service_number: 'SF-S-4471', status: 'active', language: 'English',
    auth_code: 'ROURKE-TAVI-27A4B1', phone: '+12025550131', phone_label: "Tavi's communicator",
    preferences: [['troubleshooting', 'voice'], ['repair_steps', 'sms']],
    equipment: [{ model: 'SC-9', location: 'Astrophysics Lab 2', note: 'Console firmware updated.' }],
    history: { days_ago: 3, channel: 'voice', case: { id: 'HF-031', title: 'Stellar survey report will not open', symptom: 'The stellar survey report refuses to open from the lab console', specialist: 'it', status: 'open' } } },
  { id: id(2), display_name: 'Michael Watson', rank: 'Ensign', ship: 'USS Wayfinder', department: 'sciences', section: 'Exobiology',
    clearance_level: 2, posting: 'Deck 11, Exobiology Lab', service_number: 'SF-S-4502', status: 'active', language: 'English', preferred_language: 'klingon',
    auth_code: 'Watson, Michael, five nine alpha', phone: '+12025550132', phone_label: "Michael's communicator",
    preferences: [['troubleshooting', 'voice']], equipment: [{ model: 'RPL-7', location: 'Deck 11 crew lounge', note: null }], history: null },
  { id: id(3), display_name: 'Imani Okafor', rank: 'Lieutenant Commander', ship: 'USS Wayfinder', department: 'engineering', section: 'Warp propulsion',
    clearance_level: 8, posting: 'Deck 16, Main Engineering', service_number: 'SF-E-2093', status: 'active', language: 'English',
    auth_code: 'OKAFOR-IMANI-7B21A', phone: '+12025550133', phone_label: "Imani's communicator",
    preferences: [['troubleshooting', 'voice'], ['parts_updates', 'sms']],
    equipment: [{ model: 'RPL-2400', location: 'Deck 16 ready room', note: 'Thermal regulator replaced.' }],
    history: { days_ago: 21, channel: 'voice', case: { id: 'HF-021', title: 'Replicator produces lukewarm coffee', symptom: 'Coffee arrives lukewarm', specialist: 'engineering', status: 'closed' } } },
  { id: id(4), display_name: 'Bram Halloran', rank: 'Chief Petty Officer', ship: 'USS Wayfinder', department: 'operations', section: 'Transporter maintenance',
    clearance_level: 4, posting: 'Deck 6, Transporter Room 2', service_number: 'SF-O-3310', status: 'active', language: 'English',
    auth_code: 'HALLORAN-BRAM-3A80B', phone: '+12025550134', phone_label: "Bram's communicator",
    preferences: [['troubleshooting', 'sms']], equipment: [{ model: 'FS-120', location: 'Deck 6 crew mess', note: null }],
    history: { days_ago: 10, channel: 'sms', case: { id: 'HF-027', title: 'Food synthesizer serves empty plates', symptom: 'Food synthesizer serves empty plates', specialist: 'maintenance', status: 'resolved' } } },
  { id: id(5), display_name: 'Sorrel Vance', rank: 'Lieutenant', ship: 'USS Wayfinder', department: 'security', section: 'Tactical',
    clearance_level: 6, posting: 'Deck 4, Armory', service_number: 'SF-X-1766', status: 'active', language: 'English',
    auth_code: 'VANCE-SORREL-91B3A', phone: '+12025550135', phone_label: "Sorrel's communicator",
    preferences: [['troubleshooting', 'voice']], equipment: [{ model: 'RPL-7', location: 'Deck 4 security office', note: null }], history: null },
  { id: id(6), display_name: 'Nadia Petrov', rank: 'Commander', ship: 'USS Wayfinder', department: 'medical', section: 'Sickbay',
    clearance_level: 7, posting: 'Deck 5, Sickbay', service_number: 'SF-M-0924', status: 'active', language: 'English',
    auth_code: 'PETROV-NADIA-5A06B', phone: '+12025550136', phone_label: "Nadia's communicator",
    preferences: [['troubleshooting', 'voice'], ['repair_steps', 'sms'], ['parts_updates', 'sms']],
    equipment: [{ model: 'FS-120', location: 'Sickbay galley', note: 'Nutrient matrix recalibrated.' }],
    history: { days_ago: 6, channel: 'voice', case: { id: 'HF-033', title: 'Sickbay synthesizer rejects dietary profiles', symptom: 'Synthesizer rejects every stored dietary profile', specialist: 'maintenance', status: 'open' } } },
  { id: id(7), display_name: 'Elowen Marsh', rank: 'Captain', ship: 'USS Wayfinder', department: 'command', section: 'Bridge',
    clearance_level: 10, posting: 'Deck 1, Bridge', service_number: 'SF-C-0007', status: 'active', language: 'English',
    auth_code: 'MARSH-ELOWEN-0A77B', phone: '+12025550137', phone_label: "Captain's communicator",
    preferences: [['troubleshooting', 'voice']], equipment: [{ model: 'RPL-2400', location: 'Ready room', note: null }], history: null },
  { id: id(8), display_name: 'Kai Delacroix', rank: 'Ensign', ship: 'USS Caldera', department: 'operations', section: 'Helm',
    clearance_level: 2, posting: 'Deck 1, Helm', service_number: 'SF-O-3388', status: 'transferred', language: 'French',
    auth_code: 'DELACROIX-KAI-2B19A', phone: '+12025550138', phone_label: "Kai's communicator",
    preferences: [['troubleshooting', 'voice']], equipment: [{ model: 'RPL-7', location: 'Deck 2 crew quarters', note: null }],
    history: { days_ago: 30, channel: 'voice', case: null } },
  { id: id(9), display_name: 'Bethany Ann', rank: 'Ensign', ship: 'USS Nebraska', department: 'operations', section: '',
    clearance_level: 2, posting: 'USS Nebraska', service_number: 'SF-O-4509', status: 'active', language: 'English', preferred_language: 'english',
    auth_code: 'Ann, Bethany, seven two alpha', phone: '+12025550139', phone_label: "Bethany's communicator",
    preferences: [], equipment: [], history: null },
]);

export async function seedRoster(repo, { now = new Date() } = {}) {
  const date = days => new Date(now.getTime() + days * 86400000).toISOString();
  return repo.transaction(async tx => {
    for (const person of ROSTER) {
      const existing = (await tx.find('crew_members', { id: person.id }))[0];
      if (existing && !existing.is_demo) throw new Error('Roster ID belongs to a non-demo profile');
      // Explicit, scoped cleanup of this person's records only.
      for (const c of await tx.find('cases', { crew_member_id: person.id })) {
        for (const table of ['outbound_messages', 'case_events', 'specialist_tasks', 'part_orders']) await tx.remove(table, { case_id: c.id });
      }
      for (const i of await tx.find('interactions', { crew_member_id: person.id })) await tx.remove('case_events', { interaction_id: i.id });
      await tx.remove('interactions', { crew_member_id: person.id });
      await tx.remove('cases', { crew_member_id: person.id });
      for (const table of ['equipment', 'contact_points', 'channel_preferences']) await tx.remove(table, { crew_member_id: person.id });
      await tx.remove('crew_members', { id: person.id });

      const { auth_code, phone, phone_label, preferences, equipment, history, ...crew } = person;
      await tx.insert('crew_members', { preferred_language: 'english', ...crew,
        auth_code_hash: hashAuthCode(auth_code), is_demo: true, created_at: date(-60) });
      const contactId = randomUUID();
      await tx.insert('contact_points', { id: contactId, crew_member_id: person.id, kind: 'phone', value: phone, label: phone_label, created_at: date(-60) });
      for (const [topic, channel] of preferences) await tx.insert('channel_preferences', { id: randomUUID(), crew_member_id: person.id, topic, channel, updated_at: date(-60) });
      const equipmentIds = [];
      for (const e of equipment) {
        const equipmentId = randomUUID(); equipmentIds.push(equipmentId);
        await tx.insert('equipment', { id: equipmentId, crew_member_id: person.id, model: e.model, location: e.location,
          last_service_at: e.note ? date(-45) : null, last_service_note: e.note });
      }
      if (!history) continue;
      const when = date(-history.days_ago);
      const interactionId = randomUUID();
      const c = history.case;
      if (c) {
        await tx.insert('cases', { id: c.id, crew_member_id: person.id, equipment_id: equipmentIds[0], status: c.status, title: c.title, symptom: c.symptom,
          symptom_revision: 1, diagnosis: c.status === 'open' ? null : 'Fictional cause recorded by the desk.', diagnosis_status: c.status === 'open' ? 'none' : 'confirmed_fixed',
          next_step: c.status === 'open' ? 'Awaiting the specialist result.' : null, opened_at: when, updated_at: when, resolved_at: c.status === 'open' ? null : when });
        await tx.insert('specialist_tasks', { id: randomUUID(), case_id: c.id, specialist: c.specialist, assignment: `routine: ${c.symptom}`, symptom_revision: 1,
          status: c.status === 'open' ? 'working' : 'result_ready', result: c.status === 'open' ? null : { summary: 'Fictional result; the caller confirmed the fix.' },
          created_at: when, completed_at: c.status === 'open' ? null : when,
          reply_channel: null, reply_contact_point_id: null, reply_consent_at: null, reply_claimed_at: null, reply_provider_sid: null, reply_outcome: null });
      }
      await tx.insert('interactions', { id: interactionId, case_id: c?.id ?? null, crew_member_id: person.id, channel: history.channel, direction: 'inbound',
        provider_sid: `roster-history-${person.id}`, auth_attempts: 1, started_at: when, ended_at: when });
      for (const [kind, summary] of [['profile_loaded', 'Fictional demo profile loaded.'], ...(c ? [['case_opened', c.title], ['task_started', `${c.specialist} took the request.`]] : []), ['call_ended', 'Fictional contact ended.']]) {
        await tx.insert('case_events', { id: randomUUID(), case_id: c?.id ?? null, interaction_id: interactionId, at: when, kind, summary, data: { fictional_seed: true } });
      }
    }
    await tx.resetCaseSequence();
    return { crew: ROSTER.length };
  });
}
export function promptHidden(question) {
  // Raw stdin, nothing echoed. Bracketed-paste markers and a trailing newline
  // from the paste are stripped, Backspace edits, Ctrl-C aborts.
  return new Promise((resolvePrompt, rejectPrompt) => {
    const stdin = process.stdin;
    let value = '';
    process.stderr.write(question);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const finish = (error) => {
      stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
      process.stderr.write('\n');
      if (error) rejectPrompt(error); else resolvePrompt(value.trim());
    };
    const onData = chunk => {
      for (const ch of chunk.replace(/\x1b\[20[01]~/g, '')) {
        if (ch === '\u0003') return finish(new Error('Use: cancelled'));
        if (ch === '\r' || ch === '\n') { if (value.trim()) return finish(); continue; }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
async function main() {
  const env = await readLocalEnv();
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--remote-host')) throw new Error('Use: node crm/roster.mjs [--remote-host <hostname>]');
  let url = env.DATABASE_URL;
  if (!url && args[1]) {
    // Remote seeding without DATABASE_URL in the environment: ask for it with
    // input hidden, so the URL never enters shell history or a Run-button log.
    if (!process.stdin.isTTY) throw new Error('Use: set DATABASE_URL, or run this in an interactive terminal to paste the URL at a hidden prompt');
    url = await promptHidden(`Paste the database URL for ${args[1]} (input hidden), then press Enter: `);
  }
  const connectionString = requireConfirmedDatabase(url, args[1]);
  const repo = new PostgresRepository({ connectionString });
  try {
    const { crew } = await seedRoster(repo);
    console.log(`Fictional roster loaded: ${crew} crew${args[1] ? ` on ${args[1]}` : ''}.`);
  } finally { await repo.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const known = /^(Use: |Remote database refused|A database URL|A postgres URL)/.test(error?.message ?? '');
    console.error(known ? error.message : 'Roster seed failed. Set DATABASE_URL (for example with node --env-file=.env) and make sure all migrations are applied; details are withheld.');
    process.exitCode = 1;
  });
}
