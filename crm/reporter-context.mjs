import { randomUUID } from 'node:crypto';
import { buildSharedContext, contextText, routingDesk } from '../context/shared.mjs';
import { isNonexistentDemoShip } from './ships.mjs';

export const MAX_REPORTER_CONTEXT = 64000;
export const CREW_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
// Preserve the complete text and formatting in model context; only phone-like
// numbers are withheld. The original blob remains verbatim in private CRM.
const safeText = value => typeof value === 'string' ? value.replace(/\+[1-9][\d ()-]{6,24}\d/g, '[number withheld]') : value;
const safeData = value => Array.isArray(value) ? value.map(safeData) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safeData(v)])) : safeText(value);
const select = (row, keys) => Object.fromEntries(keys.split(' ').map(key => [key, row[key] ?? null]));

export function createReporterContextService({ repo, now, safeProfile, caseSnapshot, insertTask, event, fail }) {
  async function crew(tx, id) {
    if (!CREW_ID.test(id ?? '')) fail('invalid_arguments');
    const found = (await tx.find('crew_members', { id }))[0];
    if (!found) fail('crew_member_not_found');
    if (isNonexistentDemoShip(found.ship)) fail('ship_not_found');
    return found;
  }
  async function caseView(tx, record) {
    const snapshot = await caseSnapshot(tx, record.id);
    const shared = buildSharedContext({ profile: {}, caseRecord: record, tasks: snapshot.tasks, now: now() });
    const tasks = snapshot.tasks.map(task => ({ ...select(task, 'id specialist assignment symptom_revision status created_at completed_at'),
      specialist: routingDesk(task.specialist), result: task.result ? select(task.result, 'summary diagnosis next_step source_id') : null }));
    return safeData({ ...select(record, 'id equipment_id status title symptom symptom_revision diagnosis diagnosis_status next_step opened_at updated_at resolved_at'),
      solution: shared.selected_case.solution, task_history: tasks,
      parts: snapshot.parts.map(part => select(part, 'id part_name part_number status carrier eta updated_at')),
      messages: snapshot.messages.map(message => ({ ...select(message, 'id channel body status requested_at'),
        status_history: message.status_history.map(status => select(status, 'status at error_code')) })),
      events: (await tx.find('case_events', { case_id: record.id })).map(item => select(item, 'id at kind summary')) });
  }
  async function assemble(tx, crewMemberId, contextId) {
    await crew(tx, crewMemberId);
    const records = (await tx.find('reporter_contexts', { crew_member_id: crewMemberId }))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const current = records.find(record => record.id === contextId);
    if (!current) fail('reporter_context_not_found');
    const cases = await Promise.all((await tx.find('cases', { crew_member_id: crewMemberId })).map(record => caseView(tx, record)));
    const profile = await safeProfile(tx, crewMemberId, { complete: true });
    const data = safeData({ version: 2, crew_member_id: crewMemberId, profile,
      current_reporter_context_id: contextId,
      reporter_contexts: records.map(record => ({ id: record.id, case_id: record.case_id, created_at: record.created_at, text: record.body })),
      cases, selected_case: cases.find(record => record.id === current.case_id) ?? null,
      queue: cases.flatMap(record => record.task_history.filter(task => task.symptom_revision === record.symptom_revision && task.status !== 'obsolete')
        .map(task => ({ case_id: record.id, ...task }))),
      history: (await tx.find('interactions', { crew_member_id: crewMemberId }))
        .map(item => select(item, 'id case_id channel direction started_at ended_at')) });
    return data;
  }
  return {
    async recordReporterContext({ crewMemberId, blob }) {
      if (typeof blob !== 'string' || !blob.trim() || blob.length > MAX_REPORTER_CONTEXT || blob.includes('\0') || !blob.isWellFormed()) fail('invalid_arguments');
      return repo.transaction(async tx => {
        await crew(tx, crewMemberId);
        return tx.insert('reporter_contexts', { id: randomUUID(), crew_member_id: crewMemberId, case_id: null, body: blob, created_at: now().toISOString() });
      });
    },
    getReporterContext({ crewMemberId, contextId }) { return repo.transaction(tx => assemble(tx, crewMemberId, contextId)); },
    applyReporterDecision({ context, outcome, specialist, issue, urgencyLabel }) {
      if (!['queue', 'solution'].includes(outcome) || context?.version !== 2 || typeof issue !== 'string') fail('invalid_arguments');
      if (outcome === 'queue' && !['it', 'maintenance'].includes(specialist)) fail('invalid_arguments');
      return repo.transaction(async tx => {
        const crewMemberId = context.crew_member_id;
        await crew(tx, crewMemberId);
        const intake = (await tx.find('reporter_contexts', { id: context.current_reporter_context_id, crew_member_id: crewMemberId }))[0];
        if (!intake) fail('reporter_context_not_found');
        const savedIds = (await tx.find('reporter_contexts', { crew_member_id: crewMemberId })).map(item => item.id).sort();
        if (JSON.stringify(savedIds) !== JSON.stringify(context.reporter_contexts.map(item => item.id).sort())) fail('context_changed');
        let record, solution = null;
        if (issue.startsWith('new:')) {
          if (outcome === 'solution') fail('stored_solution_unavailable');
          const generalIntake = issue === 'new:unassigned';
          const equipment = generalIntake ? null : (await tx.find('equipment', { id: issue.slice(4), crew_member_id: crewMemberId }))[0];
          if (!generalIntake && !equipment) fail('equipment_not_available');
          if (intake.case_id) {
            record = (await tx.find('cases', { id: intake.case_id, crew_member_id: crewMemberId }))[0];
            if (!record || record.equipment_id !== (equipment?.id ?? null)) fail('context_changed');
          } else if (generalIntake) {
            // Identical submitted text may be retried with another receipt.
            // Reuse only one exact, full-text, caller-owned open case; never
            // guess a match from a truncated symptom or another caller's data.
            const priorIds = [...new Set((await tx.find('reporter_contexts', { crew_member_id: crewMemberId }))
              .filter(item => item.body === intake.body && item.case_id).map(item => item.case_id))];
            const matches = (await tx.find('cases', { crew_member_id: crewMemberId, equipment_id: null, status: 'open' }))
              .filter(item => priorIds.includes(item.id) && item.symptom_revision === 1);
            if (matches.length === 1) record = matches[0];
          }
          if (!record) {
            const at = now().toISOString();
            record = await tx.insert('cases', { id: await tx.nextCaseId(), crew_member_id: crewMemberId, equipment_id: equipment?.id ?? null,
              status: 'open', title: equipment ? `${equipment.model}: reporter issue`.slice(0, 160) : `${specialist.toUpperCase()} support: ${contextText(intake.body, 120)}`,
              symptom: contextText(intake.body), symptom_revision: 1,
              diagnosis: null, diagnosis_status: 'none', next_step: null, opened_at: at, updated_at: at, resolved_at: null });
            await event(tx, record.id, null, 'case_opened', 'New issue selected from reporter context.', { reporter_context_id: intake.id });
          }
        } else {
          const original = context.cases.find(item => item.id === issue);
          record = (await tx.find('cases', { id: issue, crew_member_id: crewMemberId }))[0];
          if (!original || !record || (intake.case_id && intake.case_id !== record.id)) fail('context_changed');
          const current = await caseView(tx, record);
          if (record.symptom_revision !== original.symptom_revision || record.status !== original.status
            || JSON.stringify(current.solution) !== JSON.stringify(original.solution)) fail('context_changed');
          solution = current.solution;
        }
        if (outcome === 'solution' && !solution) fail('stored_solution_unavailable');
        if (outcome === 'queue' && record.status !== 'open') fail('case_closed');
        await tx.update('reporter_contexts', intake.id, { case_id: record.id });
        // Reload all facts after association, before inserting the handoff. The
        // complete snapshot remains immutable on a reused pending task.
        const shared = await assemble(tx, crewMemberId, intake.id);
        if (outcome === 'solution') return { context: shared, solution, task: null, reused: true };
        const pending = (await tx.find('specialist_tasks', { case_id: record.id, status: 'working', symptom_revision: record.symptom_revision }))
          .find(task => routingDesk(task.specialist) === specialist);
        if (pending) {
          const task = await tx.update('specialist_tasks', pending.id, { specialist, context_snapshot: pending.context_snapshot ?? shared });
          return { context: shared, task, solution: null, reused: true };
        }
        const task = await insertTask(tx, { id: null }, record, specialist,
          `${urgencyLabel ?? 'routine'}: Review reporter context ${intake.id} for this issue.`, shared);
        return { context: shared, task, solution: null, reused: false };
      });
    },
  };
}
