import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashAuthCode } from './service.mjs';
import { PostgresRepository } from './repo-postgres.mjs';
import { readLocalEnv, requireLocalDatabase } from './env.mjs';

export const DEMO = Object.freeze({ crewId: '00000000-0000-4000-8000-000000000001',
  equipmentId: '00000000-0000-4000-8000-000000000002', contactId: '00000000-0000-4000-8000-000000000003',
  secondEquipmentId: '00000000-0000-4000-8000-000000000004', authCode: 'CHEN-AVERY-A7B9E2' });

export async function seedDemo(repo, { scenario, phone, now = new Date(), preserveExisting = false }) {
  if (!['fresh', 'returning', 'two_open'].includes(scenario)) throw new Error('Unknown demo scenario');
  if (typeof phone !== 'string' || !/^\+[1-9]\d{1,14}$/.test(phone)) throw new Error('Missing or invalid DEMO_CALLER_E164');
  const date = days => new Date(now.getTime() + days * 86400000).toISOString();
  return repo.transaction(async tx => {
    const existing = (await tx.find('crew_members', { id: DEMO.crewId }))[0];
    if (existing && !existing.is_demo) throw new Error('Seed ID belongs to a non-demo profile');
    if (existing && preserveExisting) {
      if (existing.display_name !== 'Avery Chen') throw new Error('Demo ID belongs to a different profile');
      const nextHash = hashAuthCode(DEMO.authCode);
      if (existing.auth_code_hash === nextHash) return { scenario, added: false, phraseUpdated: false };
      if (existing.auth_code_hash !== hashAuthCode('CHEN-AVERY-A484B7')) throw new Error('Demo phrase differs from the expected old code');
      await tx.update('crew_members', DEMO.crewId, { auth_code_hash: nextHash });
      return { scenario, added: false, phraseUpdated: true };
    }
    // Explicit, scoped cleanup; do not truncate unrelated profiles or histories.
    const cases = await tx.find('cases', { crew_member_id: DEMO.crewId });
    for (const c of cases) {
      for (const table of ['outbound_messages', 'case_events', 'specialist_tasks', 'part_orders']) await tx.remove(table, { case_id: c.id });
    }
    for (const i of await tx.find('interactions', { crew_member_id: DEMO.crewId })) await tx.remove('case_events', { interaction_id: i.id });
    await tx.remove('interactions', { crew_member_id: DEMO.crewId });
    await tx.remove('cases', { crew_member_id: DEMO.crewId });
    for (const table of ['equipment', 'contact_points', 'channel_preferences']) await tx.remove(table, { crew_member_id: DEMO.crewId });
    await tx.remove('crew_members', { id: DEMO.crewId });

    await tx.insert('crew_members', { id: DEMO.crewId, display_name: 'Avery Chen', rank: 'Commander', ship: 'USS Wayfinder',
      auth_code_hash: hashAuthCode(DEMO.authCode), language: 'English', preferred_language: 'english', is_demo: true, created_at: date(-14),
      department: 'engineering', section: 'Environmental systems', clearance_level: 7, posting: 'Deck 7, Environmental Control', service_number: 'SF-E-1180', status: 'active' });
    await tx.insert('contact_points', { id: DEMO.contactId, crew_member_id: DEMO.crewId, kind: 'phone', value: phone, label: "Avery's mobile", created_at: date(-14) });
    for (const [topic, channel] of [['troubleshooting', 'voice'], ['repair_steps', 'sms']]) {
      await tx.insert('channel_preferences', { id: randomUUID(), crew_member_id: DEMO.crewId, topic, channel, updated_at: date(-14) });
    }
    await tx.insert('equipment', { id: DEMO.equipmentId, crew_member_id: DEMO.crewId, model: 'RPL-2400', location: 'Deck 7',
      last_service_at: date(-14), last_service_note: 'Thermal calibration completed.' });
    const historicalCase = (id, equipmentId, title, symptom) => ({ id, crew_member_id: DEMO.crewId, equipment_id: equipmentId,
      status: 'open', title, symptom, symptom_revision: 1, diagnosis: null, diagnosis_status: 'none', next_step: null,
      opened_at: date(-7), updated_at: date(-7), resolved_at: null });
    if (scenario !== 'fresh') {
      await tx.insert('cases', { ...historicalCase('HF-038', DEMO.equipmentId, 'Replicator drinks arrive cold', 'Coffee and tea arrive cold'),
        diagnosis: 'Calibration drift was proposed; recalibration did not fix it.', diagnosis_status: 'not_fixed', next_step: 'Await the thermal regulator, then request installation guidance.' });
      const interactionId = randomUUID();
      await tx.insert('interactions', { id: interactionId, case_id: 'HF-038', crew_member_id: DEMO.crewId, channel: 'voice', direction: 'inbound',
        provider_sid: 'demo-historical-call', auth_attempts: 1, started_at: date(-7), ended_at: date(-7) });
      for (const [specialist, assignment, result] of [
        ['engineering', 'Check the replicator thermal calibration.', { diagnosis: 'Calibration drift is a possible cause.', next_step: 'Run the calibration cycle.' }],
        ['logistics', 'Find a compatible thermal regulator.', { summary: 'A compatible regulator is available in the fictional station depot.' }],
      ]) await tx.insert('specialist_tasks', { id: randomUUID(), case_id: 'HF-038', specialist, assignment, result,
        symptom_revision: 1, status: 'result_ready', created_at: date(-7), completed_at: date(-7) });
      await tx.insert('part_orders', { id: randomUUID(), case_id: 'HF-038', part_name: 'Thermal regulator', part_number: 'TR-2400',
        status: 'shipped', carrier: 'Subspace courier', eta: date(1), updated_at: date(-7) });
      await tx.insert('outbound_messages', { id: randomUUID(), case_id: 'HF-038', contact_point_id: DEMO.contactId, channel: 'sms',
        body: 'Fictional repair recap: calibration did not fix the issue. A thermal regulator has shipped via Subspace courier.',
        status: 'delivered', status_history: ['requested', 'queued', 'submitted', 'sent', 'delivered'].map(status => ({ status, at: date(-7), error_code: null })),
        provider_sid: 'demo-historical-message', idempotency_key: 'demo-historical-recap', requested_at: date(-7), requested_in_interaction_id: interactionId });
      for (const [kind, summary] of [
        ['profile_loaded', 'Fictional demo profile loaded.'], ['case_opened', 'Coffee and tea arrived cold.'],
        ['task_started', 'Engineering checked thermal calibration.'], ['task_result', 'Engineering proposed calibration drift.'],
        ['note', 'Caller reported that recalibration did not fix the issue.'], ['task_result', 'Logistics found a compatible thermal regulator.'],
        ['part_updated', 'Fictional thermal regulator shipped via Subspace courier.'], ['message_requested', 'Caller requested the fictional repair summary.'],
        ['message_status', 'Fictional seeded SMS status: delivered.'], ['call_ended', 'Historical fictional call ended; case remains open.'],
      ]) await tx.insert('case_events', { id: randomUUID(), case_id: 'HF-038', interaction_id: interactionId, at: date(-7), kind, summary, data: { fictional_seed: true } });
    }
    if (scenario === 'two_open') {
      await tx.insert('equipment', { id: DEMO.secondEquipmentId, crew_member_id: DEMO.crewId, model: 'FS-120', location: 'Mess hall', last_service_at: null, last_service_note: null });
      await tx.insert('cases', historicalCase('HF-041', DEMO.secondEquipmentId, 'Food synthesizer produces empty plates', 'Food synthesizer produces empty plates'));
      await tx.insert('case_events', { id: randomUUID(), case_id: 'HF-041', interaction_id: null, at: date(-7), kind: 'case_opened', summary: 'Fictional food synthesizer case opened.', data: { fictional_seed: true } });
    }
    await tx.resetCaseSequence();
    return { scenario, added: true, phraseUpdated: false };
  });
}
async function main() {
  const env = await readLocalEnv();
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--scenario') throw new Error('Use --scenario fresh|returning|two_open');
  const repo = new PostgresRepository({ connectionString: requireLocalDatabase(env.DATABASE_URL) });
  try { await seedDemo(repo, { scenario: args[1], phone: env.DEMO_CALLER_E164 }); console.log(`Fictional scenario loaded: ${args[1]}.`); }
  finally { await repo.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Seed failed. Check the scenario, local DATABASE_URL and DEMO_CALLER_E164; details are withheld.'); process.exitCode = 1; });
}
