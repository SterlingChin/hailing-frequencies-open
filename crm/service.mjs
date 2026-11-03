import { createHash, randomUUID } from 'node:crypto';
import { createReporterContextService } from './reporter-context.mjs';
import { buildCaseBrief } from './brief.mjs';
import { buildSharedContext, contextText, routingDesk } from '../context/shared.mjs';

export class CRMError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new CRMError(code); };
const text = (value, max = 300) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid_arguments');
  return value.trim();
};
const one = async (tx, table, id) => (await tx.find(table, { id }))[0] ?? fail('not_found');
const enumValue = (value, allowed) => allowed.includes(value) ? value : fail('invalid_arguments');
const digits = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', alpha: 'a', beta: 'b', bravo: 'b', echo: 'e' };
export function normalizeAuthCode(value) {
  if (typeof value !== 'string' || value.length > 250) return '';
  return value.toLowerCase().replace(/^\s*authorization\b/, '').split(/[^a-z0-9]+/)
    .filter(Boolean).map(token => digits[token] ?? token).join('').toUpperCase();
}
export const hashAuthCode = value => createHash('sha256').update(normalizeAuthCode(value)).digest('hex');
const normalizeCrewName = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export const SPECIALISTS = Object.freeze(['engineering', 'logistics', 'access', 'it', 'maintenance', 'expert']);
const DIAGNOSING = ['engineering', 'it', 'maintenance'];
const E164 = /^\+[1-9]\d{1,14}$/;

export function createCRMService(repo, { now = () => new Date() } = {}) {
  const timestamp = () => now().toISOString();
  const event = (tx, caseId, interactionId, kind, summary, data = {}) => tx.insert('case_events', {
    id: randomUUID(), case_id: caseId ?? null, interaction_id: interactionId ?? null,
    at: timestamp(), kind, summary, data,
  });
  async function interaction(tx, id, { loaded = true, selected = false, active = true } = {}) {
    const i = await one(tx, 'interactions', id);
    if (active && i.ended_at) fail('interaction_ended');
    if (loaded && !i.crew_member_id) fail('profile_required');
    if (selected && !i.case_id) fail('case_required');
    return i;
  }
  const touch = (tx, id, patch = {}) => tx.update('cases', id, { ...patch, updated_at: timestamp() });
  async function caseSnapshot(tx, id) {
    return { caseRecord: await one(tx, 'cases', id), tasks: await tx.find('specialist_tasks', { case_id: id }),
      parts: await tx.find('part_orders', { case_id: id }), messages: await tx.find('outbound_messages', { case_id: id }) };
  }
  const brief = async (tx, id) => buildCaseBrief(await caseSnapshot(tx, id), now());
  async function openCases(tx, crewId) {
    const cases = (await tx.find('cases', { crew_member_id: crewId, status: 'open' })).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
    return Promise.all(cases.map(async c => ({ caseId: c.id, title: c.title, status: c.status,
      lastActivityAt: c.updated_at, brief: await brief(tx, c.id) })));
  }
  async function safeProfile(tx, crewId, { complete = false } = {}) {
    const crew = await one(tx, 'crew_members', crewId);
    // "When they talked to us" is derived from finished interactions, never stored twice.
    const finished = (await tx.find('interactions', { crew_member_id: crewId })).filter(i => i.ended_at)
      .sort((a, b) => b.ended_at.localeCompare(a.ended_at) || a.id.localeCompare(b.id));
    const last = finished[0];
    return { display_name: crew.display_name, rank: crew.rank, ship: crew.ship, language: crew.language,
      preferred_language: crew.preferred_language === 'klingon' ? 'klingon' : 'english',
      department: crew.department ?? null, section: crew.section ?? null, clearance_level: crew.clearance_level ?? null,
      posting: crew.posting ?? null, service_number: crew.service_number ?? null, status: crew.status ?? 'active',
      contact_count: finished.length,
      last_contact: last ? { at: last.ended_at, channel: last.channel, direction: last.direction, case_id: last.case_id } : null,
      equipment: (await tx.find('equipment', { crew_member_id: crewId })).map(({ crew_member_id, ...equipment }) => equipment),
      preferences: (await tx.find('channel_preferences', { crew_member_id: crewId })).map(({ topic, channel }) => ({ topic, channel })),
      open_cases: await openCases(tx, crewId),
      recent_cases: await Promise.all((await tx.find('cases', { crew_member_id: crewId })).filter(c => c.status !== 'open')
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)).slice(0, complete ? Infinity : 5)
        .map(async c => ({ caseId: c.id, title: c.title, status: c.status, lastActivityAt: c.updated_at, brief: await brief(tx, c.id) }))) };
  }
  async function linkProfileEvent(tx, i, caseId) {
    for (const e of await tx.find('case_events', { interaction_id: i.id, kind: 'profile_loaded', case_id: null })) {
      await tx.update('case_events', e.id, { case_id: caseId });
    }
  }

  async function sharedContext(tx, i, request = null, channel = i.channel) {
    const snapshot = i.case_id ? await caseSnapshot(tx, i.case_id) : null;
    return buildSharedContext({ profile: await safeProfile(tx, i.crew_member_id),
      caseRecord: snapshot?.caseRecord, tasks: snapshot?.tasks,
      caseBrief: snapshot ? buildCaseBrief(snapshot, now()) : null, request, channel, now: now() });
  }
  async function insertTask(tx, i, c, specialist, assignment, contextSnapshot = null) {
    const task = await tx.insert('specialist_tasks', { id: randomUUID(), case_id: c.id, specialist, assignment,
      symptom_revision: c.symptom_revision, status: 'working', result: null, created_at: timestamp(), completed_at: null,
      reply_channel: null, reply_contact_point_id: null, reply_consent_at: null, reply_claimed_at: null, reply_provider_sid: null,
      reply_outcome: null, context_snapshot: contextSnapshot });
    await event(tx, c.id, i.id, 'task_started', contextSnapshot ? `${specialist} handoff saved; awaiting reporting-agent dispatch.` : `${specialist} started the assigned check.`, { task_id: task.id, symptom_revision: c.symptom_revision });
    await touch(tx, c.id);
    return task;
  }

  return {
    ...createReporterContextService({ repo, now, safeProfile, caseSnapshot, insertTask, event, fail }),
    findCandidatesByPhone(e164) {
      if (typeof e164 !== 'string' || !/^\+[1-9]\d{1,14}$/.test(e164)) return Promise.resolve([]);
      return repo.transaction(async tx => [...new Set((await tx.find('contact_points', { kind: 'phone', value: e164 })).map(p => p.crew_member_id))]);
    },
    beginInteraction({ providerSid, channel = 'voice', direction = 'inbound' }) {
      text(providerSid, 100);
      enumValue(channel, ['voice', 'sms']); enumValue(direction, ['inbound', 'outbound']);
      return repo.transaction(async tx => {
        const existing = (await tx.find('interactions', { provider_sid: providerSid }))[0];
        if (existing) return existing;
        return tx.insert('interactions', { id: randomUUID(), case_id: null, crew_member_id: null,
          channel, direction, provider_sid: providerSid, auth_attempts: 0, started_at: timestamp(), ended_at: null });
      });
    },
    loadProfileByAuthCode({ spokenCode, name = null, candidateIds = [], interactionId, demoOnly = false }) {
      const callerName = name === null ? null : normalizeCrewName(text(name, 120));
      return repo.transaction(async tx => {
        const i = await interaction(tx, interactionId, { loaded: false });
        if (i.auth_attempts >= 3) return { ok: false, error: { code: 'auth_attempt_limit' } };
        await tx.update('interactions', i.id, { auth_attempts: i.auth_attempts + 1 });
        // Phone candidates are only hints. The phrase is required even for one match;
        // an unlisted/shared/withheld number does not prevent loading by the exact phrase.
        const matches = callerName === null
          ? await tx.find('crew_members', { auth_code_hash: hashAuthCode(spokenCode) })
          : (await tx.find('crew_members')).filter(crew => {
            if (normalizeCrewName(crew.display_name) !== callerName) return false;
            // Existing demo hashes include surname/given-name before the code.
            // Derive that prefix from the matching CRM record, so callers can
            // send name and authorization separately without rotating records.
            const prefix = crew.display_name.normalize('NFKC').trim().split(/\s+/).reverse().join('-');
            return [hashAuthCode(spokenCode), hashAuthCode(`${prefix}-${normalizeAuthCode(spokenCode)}`)].includes(crew.auth_code_hash);
          });
        matches.sort((a, b) => Number(candidateIds.includes(b.id)) - Number(candidateIds.includes(a.id)));
        const crew = matches.find(match => !demoOnly || match.is_demo);
        if (!normalizeAuthCode(spokenCode) || !crew || (i.crew_member_id && i.crew_member_id !== crew.id)) {
          return { ok: false, error: { code: 'profile_not_found' } };
        }
        await tx.update('interactions', i.id, { crew_member_id: crew.id });
        if (!i.crew_member_id) await event(tx, i.case_id, i.id, 'profile_loaded', 'Demo profile loaded.');
        return { ok: true, crewId: crew.id, profile: await safeProfile(tx, crew.id) };
      });
    },
    getInteractionProfile(interactionId) {
      return repo.transaction(async tx => {
        const i = await interaction(tx, interactionId);
        return safeProfile(tx, i.crew_member_id);
      });
    },
    listOpenCases(crewId) { return repo.transaction(tx => openCases(tx, crewId)); },
    getCaseBrief(caseId) { return repo.transaction(tx => brief(tx, caseId)); },
    getInteractionBrief(interactionId) {
      return repo.transaction(async tx => brief(tx, (await interaction(tx, interactionId, { selected: true })).case_id));
    },
    /** Fresh, safe CRM data. Profile loading is mandatory; case selection remains explicit. */
    getInteractionContext({ interactionId, request = null, channel = 'voice' }) {
      if (request !== null) request = contextText(text(request, 500), 500);
      enumValue(channel, ['voice', 'sms']);
      return repo.transaction(async tx => sharedContext(tx, await interaction(tx, interactionId), request, channel));
    },
    /** Commit a classification against the exact case revision it saw. Never let
     * model confidence substitute for stored solution evidence or ownership. */
    applyRoutingDecision({ interactionId, context, outcome, specialist = null, assignment = null }) {
      enumValue(outcome, ['solution', 'queue']);
      if (outcome === 'queue') { enumValue(specialist, ['it', 'maintenance']); assignment = contextText(text(assignment), 300); }
      return repo.transaction(async tx => {
        const i = await interaction(tx, interactionId, { selected: true });
        const c = await one(tx, 'cases', i.case_id);
        if (context?.version !== 1 || context.selected_case?.id !== c.id || context.selected_case.symptom_revision !== c.symptom_revision) fail('context_changed');
        const current = await sharedContext(tx, i, context.request, context.channel);
        if (JSON.stringify(current.selected_case.solution) !== JSON.stringify(context.selected_case.solution)) fail('context_changed');
        if (outcome === 'solution') {
          if (!current.selected_case.solution) fail('stored_solution_unavailable');
          return { task: null, solution: current.selected_case.solution, reused: true, context: current };
        }
        if (c.status !== 'open') fail('case_closed');
        const pending = (await tx.find('specialist_tasks', { case_id: c.id, status: 'working', symptom_revision: c.symptom_revision }))
          .find(t => routingDesk(t.specialist) === specialist);
        if (pending) {
          // Preserve an existing handoff; legacy tasks acquire a snapshot when
          // first encountered by the new routing workflow.
          const task = await tx.update('specialist_tasks', pending.id, { specialist, context_snapshot: pending.context_snapshot ?? context });
          return { task, solution: null, reused: true, context: current };
        }
        const task = await insertTask(tx, i, c, specialist, assignment, context);
        return { task, solution: null, reused: false, context };
      });
    },
    attachInteraction({ interactionId, caseId, callerConfirmed = false, reviewOnly = false }) {
      if (callerConfirmed !== true) fail('confirmation_required');
      return repo.transaction(async tx => {
        const i = await interaction(tx, interactionId);
        const c = await one(tx, 'cases', caseId);
        if (c.crew_member_id !== i.crew_member_id) fail('case_not_available');
        if (c.status === 'closed' && !reviewOnly) fail('case_closed');
        if (i.case_id && i.case_id !== c.id) fail('case_already_selected');
        if (!i.case_id) {
          await tx.update('interactions', i.id, { case_id: c.id });
          await linkProfileEvent(tx, i, c.id);
          if (!reviewOnly) await touch(tx, c.id, { status: 'open', resolved_at: null });
          await event(tx, c.id, i.id, 'case_resumed', reviewOnly ? 'Caller confirmed reviewing this case; its status is unchanged.' : 'Caller confirmed this case.');
        }
        return { caseId: c.id, brief: await brief(tx, c.id) };
      });
    },
    openCase({ interactionId, equipmentId, symptom }) {
      symptom = text(symptom);
      return repo.transaction(async tx => {
        const i = await interaction(tx, interactionId);
        if (i.case_id && (await one(tx, 'cases', i.case_id)).status === 'open') fail('case_already_selected');
        const equipment = await one(tx, 'equipment', equipmentId);
        if (equipment.crew_member_id !== i.crew_member_id) fail('equipment_not_available');
        const caseId = await tx.nextCaseId();
        await tx.insert('cases', { id: caseId, crew_member_id: i.crew_member_id, equipment_id: equipmentId,
          status: 'open', title: `${equipment.model}: ${symptom}`.slice(0, 160), symptom, symptom_revision: 1,
          diagnosis: null, diagnosis_status: 'none', next_step: null, opened_at: timestamp(), updated_at: timestamp(), resolved_at: null });
        await tx.update('interactions', i.id, { case_id: caseId });
        await linkProfileEvent(tx, i, caseId);
        await event(tx, caseId, i.id, 'case_opened', 'Caller opened a new equipment case.');
        return { caseId, brief: await brief(tx, caseId) };
      });
    },
    updateSymptom({ interactionId, symptom }) {
      symptom = text(symptom);
      return repo.transaction(async tx => {
        const i = await interaction(tx, interactionId, { selected: true });
        const c = await one(tx, 'cases', i.case_id);
        if (c.status !== 'open') fail('case_closed');
        if (c.symptom === symptom) return c;
        const updated = await touch(tx, c.id, { symptom, symptom_revision: c.symptom_revision + 1,
          diagnosis: null, diagnosis_status: 'none', next_step: null });
        for (const task of await tx.find('specialist_tasks', { case_id: c.id })) {
          if (task.status !== 'obsolete') await tx.update('specialist_tasks', task.id, { status: 'obsolete' });
        }
        await event(tx, c.id, i.id, 'symptom_updated', 'Caller revised the symptom; earlier findings are obsolete.', { symptom_revision: updated.symptom_revision });
        return updated;
      });
    },
    startTask({ interactionId, specialist, assignment }) {
      enumValue(specialist, SPECIALISTS); assignment = text(assignment);
      return repo.transaction(async tx => {
        const i = await interaction(tx, interactionId, { selected: true });
        const c = await one(tx, 'cases', i.case_id);
        if (c.status !== 'open') fail('case_closed');
        const task = await insertTask(tx, i, c, specialist, assignment);
        const equipment = c.equipment_id ? await one(tx, 'equipment', c.equipment_id) : null;
        return { ...task, equipment_model: equipment?.model ?? null, symptom: c.symptom };
      });
    },
    recordTaskResult({ taskId, result, failed = false }) {
      // A bounded structured result, never a transcript or arbitrary provider payload.
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
          Object.keys(result).some(k => !['diagnosis', 'next_step', 'summary', 'source_id'].includes(k))) fail('invalid_arguments');
      result = Object.fromEntries(Object.entries(result).map(([k, v]) => [k, text(v, 300)]));
      return repo.transaction(async tx => {
        const task = await one(tx, 'specialist_tasks', taskId);
        if (task.completed_at) return task;
        const c = await one(tx, 'cases', task.case_id);
        const stale = task.symptom_revision !== c.symptom_revision || c.status !== 'open' || task.status === 'obsolete';
        const status = stale ? 'obsolete' : failed ? 'failed' : 'result_ready';
        const updated = await tx.update('specialist_tasks', task.id, { status, result, completed_at: timestamp() });
        const finding = result.diagnosis ?? (['it', 'maintenance'].includes(task.specialist) ? result.summary : null);
        if (!stale && !failed && DIAGNOSING.includes(task.specialist) && finding && !['confirmed_fixed', 'not_fixed'].includes(c.diagnosis_status)) {
          await touch(tx, c.id, { diagnosis: finding, diagnosis_status: 'proposed', next_step: result.next_step ?? null });
        } else await touch(tx, c.id);
        await event(tx, c.id, null, 'task_result', `${task.specialist} result recorded as ${status}.`, { task_id: task.id, symptom_revision: task.symptom_revision });
        return updated;
      });
    },
    /** Task payload for a specialist worker: bounded, no phone numbers, no hashes. */
    getTaskAssignment(taskId) {
      return repo.transaction(async tx => {
        const task = await one(tx, 'specialist_tasks', taskId);
        const c = await one(tx, 'cases', task.case_id);
        const equipment = c.equipment_id ? await one(tx, 'equipment', c.equipment_id) : null;
        return { id: task.id, case_id: c.id, specialist: task.specialist, assignment: task.assignment, status: task.status,
          symptom_revision: task.symptom_revision, equipment_model: equipment?.model ?? null, equipment_location: equipment?.location ?? null,
          symptom: c.symptom, brief: await brief(tx, c.id), reply_channel: task.reply_channel,
          context: task.context_snapshot ?? null };
      });
    },
    /** The caller, on the call that queued the task, asks to be called or texted back at the number they are using. */
    recordReplyConsent({ interactionId, taskId, channel, fromE164, explicitRequest = false, confirmedDestination = false }) {
      if (explicitRequest !== true || confirmedDestination !== true) fail('reply_request_required');
      enumValue(channel, ['voice', 'sms']);
      return repo.transaction(async tx => {
        const i = await interaction(tx, interactionId, { selected: true });
        const task = await one(tx, 'specialist_tasks', taskId);
        if (task.case_id !== i.case_id) fail('task_not_available');
        // A fast specialist may finish while the officer asks about a reply.
        if (!['working', 'result_ready'].includes(task.status)) fail('task_not_pending');
        if (task.reply_channel) return task;
        const contact = E164.test(fromE164 ?? '') ? (await tx.find('contact_points', { crew_member_id: i.crew_member_id, kind: 'phone', value: fromE164 }))[0] : null;
        if (!contact) fail('contact_not_available');
        const updated = await tx.update('specialist_tasks', task.id, { reply_channel: channel, reply_contact_point_id: contact.id, reply_consent_at: timestamp() });
        await event(tx, task.case_id, i.id, 'reply_requested', `Caller asked for a ${channel === 'sms' ? 'text' : 'call'} back when the ${task.specialist} result is ready.`, { task_id: task.id, channel });
        await touch(tx, task.case_id);
        return updated;
      });
    },
    listRepliesDue() {
      return repo.transaction(async tx => (await tx.find('specialist_tasks', { status: 'result_ready', reply_claimed_at: null }))
        .filter(t => t.reply_channel).map(t => ({ id: t.id, case_id: t.case_id, channel: t.reply_channel, completed_at: t.completed_at })));
    },
    /** Everything the reply step needs, computed only from stored records. */
    prepareTaskReply(taskId) {
      return repo.transaction(async tx => {
        const task = await one(tx, 'specialist_tasks', taskId);
        if (!task.reply_channel) fail('reply_not_requested');
        if (task.status !== 'result_ready') fail('reply_not_ready');
        const contact = await one(tx, 'contact_points', task.reply_contact_point_id);
        const c = await one(tx, 'cases', task.case_id);
        const r = task.result ?? {};
        const body = `${c.id} — fictional ${task.specialist} result. ${[r.summary, r.diagnosis && `Finding: ${r.diagnosis}`, r.next_step && `Next: ${r.next_step}`].filter(Boolean).join(' ')}`.slice(0, 1200);
        return { taskId: task.id, caseId: c.id, crewId: c.crew_member_id, channel: task.reply_channel, specialist: task.specialist,
          contactPointId: contact.id, to: contact.value, destinationLabel: contact.label, body,
          claimed: Boolean(task.reply_claimed_at), providerSid: task.reply_provider_sid, outcome: task.reply_outcome,
          idempotencyKey: `${task.id}:reply:${task.reply_channel}` };
      });
    },
    /** An outbound interaction bound to the task's case so message and call records attach to the same history. */
    beginReplyInteraction(taskId) {
      return repo.transaction(async tx => {
        const task = await one(tx, 'specialist_tasks', taskId);
        if (!task.reply_channel) fail('reply_not_requested');
        const providerSid = `reply:${task.reply_channel}:${task.id}`;
        const existing = (await tx.find('interactions', { provider_sid: providerSid }))[0];
        if (existing) return existing;
        const c = await one(tx, 'cases', task.case_id);
        const i = await tx.insert('interactions', { id: randomUUID(), case_id: c.id, crew_member_id: c.crew_member_id,
          channel: task.reply_channel, direction: 'outbound', provider_sid: providerSid, auth_attempts: 0, started_at: timestamp(), ended_at: null });
        await event(tx, c.id, i.id, 'reply_started', `Outbound ${task.reply_channel} reply started for the ${task.specialist} result.`, { task_id: task.id });
        return i;
      });
    },
    claimTaskReply(taskId) {
      return repo.transaction(async tx => {
        const task = await one(tx, 'specialist_tasks', taskId);
        if (!task.reply_channel) fail('reply_not_requested');
        if (task.status !== 'result_ready') fail('reply_not_ready');
        if (task.reply_claimed_at) return { claimed: false, task };
        const updated = await tx.update('specialist_tasks', task.id, { reply_claimed_at: timestamp() });
        await event(tx, task.case_id, null, 'reply_claimed', `Reply attempt claimed over ${task.reply_channel}; the outcome is not yet known.`, { task_id: task.id });
        return { claimed: true, task: updated };
      });
    },
    recordTaskReplyOutcome({ taskId, outcome, providerSid = null }) {
      enumValue(outcome, ['placed', 'submitted', 'failed', 'unavailable']);
      if (providerSid != null) providerSid = text(providerSid, 100);
      return repo.transaction(async tx => {
        const task = await one(tx, 'specialist_tasks', taskId);
        if (!task.reply_claimed_at) fail('reply_not_claimed');
        if (task.reply_provider_sid && providerSid && providerSid !== task.reply_provider_sid) fail('provider_sid_conflict');
        const updated = await tx.update('specialist_tasks', task.id, { reply_outcome: outcome, reply_provider_sid: task.reply_provider_sid ?? providerSid });
        await event(tx, task.case_id, null, 'reply_outcome', `Reply over ${task.reply_channel}: ${outcome}.`, { task_id: task.id });
        await touch(tx, task.case_id);
        return updated;
      });
    },
    recordDiagnosisOutcome({ interactionId, outcome, callerConfirmed = false }) {
      if (callerConfirmed !== true) fail('confirmation_required');
      enumValue(outcome, ['confirmed_fixed', 'not_fixed']);
      return repo.transaction(async tx => {
        const i = await interaction(tx, interactionId, { selected: true });
        const c = await one(tx, 'cases', i.case_id);
        if (c.status !== 'open') fail('case_closed');
        if (!c.diagnosis) fail('diagnosis_required');
        // Sterling's decision: a confirmed fix does not close or resolve the case.
        const updated = await touch(tx, c.id, { diagnosis_status: outcome });
        await event(tx, c.id, i.id, 'note', `Caller reported repair outcome: ${outcome}.`);
        return updated;
      });
    },
    closeCase({ interactionId, callerConfirmed = false }) {
      if (callerConfirmed !== true) fail('confirmation_required');
      return repo.transaction(async tx => {
        const i = await interaction(tx, interactionId, { selected: true });
        const c = await one(tx, 'cases', i.case_id);
        if (c.status === 'closed') return c;
        const updated = await touch(tx, c.id, { status: 'closed', resolved_at: c.diagnosis_status === 'confirmed_fixed' ? timestamp() : null });
        await event(tx, c.id, i.id, 'note', 'Caller explicitly closed the case.');
        return updated;
      });
    },
    recordPartUpdate({ caseId, partId = randomUUID(), partName, partNumber, status, carrier = null, eta = null }) {
      partName = text(partName, 100); partNumber = text(partNumber, 80);
      enumValue(status, ['available', 'reserved', 'ordered', 'shipped', 'delivered', 'cancelled']);
      if (status === 'shipped' && (!carrier || !eta)) fail('shipment_details_required');
      if (carrier != null) carrier = text(carrier, 100);
      if (eta != null) {
        if (typeof eta !== 'string' || !Number.isFinite(Date.parse(eta))) fail('invalid_arguments');
        eta = new Date(eta).toISOString();
      }
      return repo.transaction(async tx => {
        await one(tx, 'cases', caseId);
        const existing = (await tx.find('part_orders', { id: partId }))[0];
        if (existing && existing.case_id !== caseId) fail('part_not_available');
        const row = { case_id: caseId, part_name: partName, part_number: partNumber, status, carrier, eta, updated_at: timestamp() };
        const part = existing ? await tx.update('part_orders', partId, row) : await tx.insert('part_orders', { id: partId, ...row });
        await event(tx, caseId, null, 'part_updated', `Part record updated to ${status}.`, { part_id: partId });
        await touch(tx, caseId);
        return part;
      });
    },
    prepareRepairFollowup({ interactionId, fromE164 }) {
      return repo.transaction(async tx => {
        const i = await interaction(tx, interactionId, { selected: true });
        const c = await one(tx, 'cases', i.case_id);
        if (!c.diagnosis || !c.next_step) fail('repair_summary_unavailable');
        const outcome = { proposed: 'Possible cause', confirmed_fixed: 'Caller confirmed fixed', not_fixed: 'Caller reports not fixed' }[c.diagnosis_status];
        const body = `${c.id} — fictional repair summary. ${outcome}: ${c.diagnosis} Steps: ${c.next_step}`;
        const contact = (await tx.find('contact_points', { crew_member_id: i.crew_member_id, kind: 'phone', value: fromE164 ?? '' }))[0];
        const digest = createHash('sha256').update(body).digest('hex').slice(0, 24);
        return { body, contactPointId: contact?.id ?? null, to: contact?.value ?? null,
          destinationLabel: contact?.label ?? 'No eligible caller contact',
          idempotencyKey: `${i.id}:repair:${c.symptom_revision}:${digest}` };
      });
    },
    claimMessageSend(messageId) {
      return repo.transaction(async tx => {
        const message = await one(tx, 'outbound_messages', messageId);
        if (message.status !== 'requested') return { claimed: false, message };
        const updated = await tx.update('outbound_messages', message.id, { status: 'queued',
          status_history: [...message.status_history, { status: 'queued', at: timestamp(), error_code: null }] });
        await event(tx, message.case_id, null, 'message_status', 'SMS send attempt claimed; delivery is not confirmed.', { message_id: message.id });
        await touch(tx, message.case_id);
        return { claimed: true, message: updated };
      });
    },
    getMessageForCallback(messageId) {
      return repo.transaction(async tx => {
        const message = await one(tx, 'outbound_messages', messageId);
        if (message.status === 'requested') fail('message_not_submitted');
        return { id: message.id, providerSid: message.provider_sid };
      });
    },
    requestMessage({ interactionId, contactPointId, body, idempotencyKey, explicitRequest = false }) {
      if (explicitRequest !== true) fail('message_request_required');
      body = text(body, 1600); idempotencyKey = text(idempotencyKey, 150);
      return repo.transaction(async tx => {
        const i = await interaction(tx, interactionId, { selected: true });
        const contact = await one(tx, 'contact_points', contactPointId);
        if (contact.crew_member_id !== i.crew_member_id) fail('contact_not_available');
        const existing = (await tx.find('outbound_messages', { idempotency_key: idempotencyKey }))[0];
        if (existing) {
          if (existing.case_id !== i.case_id || existing.contact_point_id !== contactPointId || existing.body !== body) fail('idempotency_conflict');
          return existing;
        }
        const at = timestamp();
        const message = await tx.insert('outbound_messages', { id: randomUUID(), case_id: i.case_id,
          contact_point_id: contactPointId, channel: 'sms', body, status: 'requested',
          status_history: [{ status: 'requested', at, error_code: null }], provider_sid: null,
          idempotency_key: idempotencyKey, requested_at: at, requested_in_interaction_id: i.id });
        await event(tx, i.case_id, i.id, 'message_requested', 'Caller explicitly requested an SMS; it has not been sent.', { message_id: message.id });
        await touch(tx, i.case_id);
        return message;
      });
    },
    recordMessageStatus({ messageId, status, providerSid = null, errorCode = null, at = timestamp() }) {
      const order = { requested: 0, queued: 1, submitted: 2, sent: 3, delivered: 4, failed: 4, undelivered: 4 };
      enumValue(status, Object.keys(order));
      if (!Number.isFinite(Date.parse(at))) fail('invalid_arguments');
      at = new Date(at).toISOString();
      if (providerSid != null) providerSid = text(providerSid, 100);
      if (errorCode != null && !/^\d{1,8}$/.test(String(errorCode))) fail('invalid_arguments');
      return repo.transaction(async tx => {
        const message = await one(tx, 'outbound_messages', messageId);
        if (message.provider_sid && providerSid && providerSid !== message.provider_sid) fail('provider_sid_conflict');
        if (['submitted', 'sent', 'delivered', 'undelivered'].includes(status) && !providerSid && !message.provider_sid) fail('provider_sid_required');
        // The first terminal outcome wins; contradictory/late callbacks remain in history.
        const nextStatus = order[message.status] < 4 && order[status] > order[message.status] ? status : message.status;
        const updated = await tx.update('outbound_messages', messageId, { status: nextStatus,
          provider_sid: message.provider_sid ?? providerSid,
          status_history: [...message.status_history, { status, at, error_code: errorCode == null ? null : String(errorCode) }] });
        await event(tx, message.case_id, null, 'message_status', `SMS status observed: ${status}; current status: ${nextStatus}.`, { message_id: message.id });
        await touch(tx, message.case_id);
        return updated;
      });
    },
    endInteraction(interactionId) {
      return repo.transaction(async tx => {
        const i = await interaction(tx, interactionId, { loaded: false, active: false });
        if (i.ended_at) return i;
        const updated = await tx.update('interactions', i.id, { ended_at: timestamp() });
        await event(tx, i.case_id, i.id, 'call_ended', 'Interaction ended; pending case work is retained.');
        if (i.case_id) await touch(tx, i.case_id);
        return updated;
      });
    },
  };
}
