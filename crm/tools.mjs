import { CRMError } from './service.mjs';
import { reportingAction } from '../decisions/reporting-action.mjs';
import { lookupParts as fictionalParts } from '../specialists/catalog.mjs';

const string = { type: 'string' };
const confirmation = { type: 'boolean', enum: [true] };
const tool = (name, description, properties) => ({ type: 'function', name, description, strict: true,
  parameters: { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) } });
export const CRM_TOOLS = [
  tool('request_repair_sms', 'Send the stored repair summary ONLY when the caller explicitly asks for a text AND confirms the number they are calling from is the destination. No preference-based sends; no alternate phone numbers.', { caller_requested: confirmation, caller_confirmed_destination: confirmation }),
  tool('check_parts', 'Ask Logistics to check the fictional catalog for the selected case’s equipment. Availability only; never reserves, orders or ships.', {}),
  tool('load_crew_profile', 'Load a fictional demo profile using the caller’s spoken authorization phrase. A phrase match does not establish that the assigned ship exists; Decisions performs that check before accepting a report. The returned preferred_language controls spoken replies only after a successful load. This is not identity or voiceprint verification.', { spoken_code: string }),
  tool('resume_case', 'Attach one of the loaded profile’s cases ONLY AFTER asking and receiving caller confirmation. If several cases are open, ask which one.', { case_id: string, caller_confirmed: confirmation }),
  tool('review_case', 'Review a caller-confirmed existing case, including a resolved or closed case, without reopening it. Use this to look up a stored solution. A changed or new problem needs a new case.', { case_id: string, caller_confirmed: confirmation }),
  tool('open_case', 'Open a new case when the loaded caller asks for help with a new issue. Use an equipment ID returned by load_crew_profile.', { equipment_id: string, symptom: string }),
  tool('update_symptom', 'Record the caller’s corrected symptom for the selected case; old findings become obsolete.', { symptom: string }),
  tool('get_case_brief', 'Read stored facts for this call’s selected case only.', {}),
  tool('get_crm_context', 'Refresh the safe CRM profile, selected case, current queue and stored solution after the demo profile loads. No contact numbers or authorization secrets are returned.', {}),
  tool('record_repair_outcome', 'Record confirmed_fixed or not_fixed ONLY when the caller explicitly reports the result. This leaves the case open.',
    { outcome: { type: 'string', enum: ['confirmed_fixed', 'not_fixed'] }, caller_confirmed: confirmation }),
  tool('close_case', 'Close the selected case ONLY after the caller explicitly asks to close it. A confirmed fix by itself is insufficient.', { caller_confirmed: confirmation }),
  tool('route_request', 'Route the caller’s request for the confirmed case: reuse its stored solution now, ask for details, or prepare an IT/Maintenance MCP handoff for the reporting agent to execute. Update a changed symptom first. Expert is the shared entry point, not a destination. Pass the caller’s own words.', { request: string }),
  tool('request_reply', 'Record that the caller explicitly asked to be called or texted back at the number they are calling from when a queued task finishes. Use the task_id returned by route_request.',
    { task_id: string, channel: { type: 'string', enum: ['voice', 'sms'] }, caller_requested: confirmation, caller_confirmed_destination: confirmation }),
];
export const MEMORY_INSTRUCTIONS = 'Use only facts returned by tools. Before the profile loads, speak English. After it loads, use preferred_language for spoken replies: English for english, Klingon for klingon. Keep tool names, IDs and stored CRM values unchanged. After the profile loads, use its crm_context and refresh it with get_crm_context when needed. For a caller-confirmed resolved or closed issue, use review_case without reopening it. When route_request returns solution, explain the returned solution on this call; do not queue another task or request a callback. IT and Maintenance own their callbacks directly; the reporting agent handles the initial call. A saved callback request is consent, not proof that a call has been placed. When route_request returns queue, its action is a saved handoff, not an executed MCP call. The reporting backend must reconcile or claim action.dispatch_key before calling action.tool_call with the supplied context argument. Never claim the expert started until its acknowledgement arrives. Record callback consent with request_reply, but do not promise delivery from consent alone. When route_request returns needs_more_details, ask one question, save a changed symptom with update_symptom, and request a fresh decision. On a return call, share case details only after the profile loads and the caller confirms the case. Ask for the fictional authorization phrase before discussing any profile or history; a phone number is only a lookup hint. Say "demo profile loaded", never "verified". After loading, if one case is open, ask if this call concerns it; if several are open, ask which one. Never resume without explicit caller confirmation. For a new issue, open a case using the returned equipment ID. Record symptom corrections before seeking a new repair. A proposed diagnosis is not a fix; only the caller can report confirmed_fixed or not_fixed. Leave even a confirmed fix open until the caller explicitly asks to close it. Say a part is on its way only when its record is shipped; report its stored carrier and ETA. Say an SMS was delivered only when its record says delivered. SMS preferences do not request or send messages. Only call request_repair_sms after the caller explicitly asks for the repair text and confirms sending to the number they are calling from. Report the returned status; submitted is not delivered. If unavailable, offer to read the returned summary. The companion screen currently shows a fixture; never claim the live summary is visible there. No ordering actions are available. If case records are unavailable, say you cannot reach them right now and offer fictional repair help without inventing history.';
const unavailable = () => ({ ok: false, error: { code: 'memory_unavailable' }, message: "I can't reach case records right now. I can still help with fictional repairs, but cannot recall or save case history." });
const failed = code => ({ ok: false, error: { code } });

/** Private call context never appears in prompts, logs, or model arguments. */
export function createCallTools({ service, context, lookupRepair, lookupParts = fictionalParts, smsFollowup = null, decisionStep = null, onReplyRequested = null }) {
  let ended = false;
  let queue = Promise.resolve();
  const ready = (async () => {
    if (!service) return false;
    try {
      const i = await service.beginInteraction({ providerSid: context.callSid, direction: context.callbackTaskId ? 'outbound' : 'inbound' });
      context.interactionId = i.id;
      context.candidateIds = await service.findCandidatesByPhone(context.fromE164);
      return true;
    } catch { return false; }
  })();
  const serialize = work => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  function validate(name, args) {
    const definition = CRM_TOOLS.find(t => t.name === name);
    if (!definition) return false;
    const props = definition.parameters.properties;
    return args && typeof args === 'object' && !Array.isArray(args) &&
      (args.case_id === undefined || /^HF-\d{3,12}$/.test(args.case_id)) &&
      (args.equipment_id === undefined || /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(args.equipment_id)) &&
      (args.task_id === undefined || /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(args.task_id)) &&
      (args.request === undefined || (args.request.trim().length > 0 && args.request.length <= 500)) &&
      Object.keys(args).length === Object.keys(props).length &&
      Object.entries(props).every(([k, schema]) => Object.hasOwn(args, k) && typeof args[k] === schema.type &&
        (!schema.enum || schema.enum.includes(args[k])));
  }
  async function repair(args) {
    if (ended) return failed('interaction_ended');
    if (!args || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).some(k => !['equipment_model', 'symptom'].includes(k)) ||
        typeof args.equipment_model !== 'string' || typeof args.symptom !== 'string' ||
        args.equipment_model.length > 80 || args.symptom.length > 300) return failed('invalid_repair_arguments');
    if (!(await ready)) return { ...await lookupRepair(args), memory: unavailable() };
    if (!context.caseId) return { ...await lookupRepair(args), memory: { saved: false, reason: 'No case selected.' } };
    let task;
    let catalog;
    try {
      task = await service.startTask({ interactionId: context.interactionId, specialist: 'engineering', assignment: 'Consult the fictional repair catalog for the reported symptom.' });
      // Snapshot the selected equipment and revision BEFORE asynchronous work.
      // Model-supplied old symptoms cannot be filed against a newer revision.
      catalog = await lookupRepair({ equipment_model: task.equipment_model, symptom: task.symptom });
      const recorded = await service.recordTaskResult({ taskId: task.id, failed: !catalog?.ok, result: catalog?.ok ? {
        diagnosis: catalog.diagnosis, next_step: catalog.steps.join(' '), source_id: catalog.source_id,
      } : { summary: 'No fictional repair procedure was returned.' } });
      if (recorded.status === 'obsolete') return { ok: false, error: { code: 'obsolete_result' }, message: 'The symptom changed. Request a new repair lookup.' };
      return { ...catalog, task_status: recorded.status };
    } catch (error) {
      if (task && !catalog) {
        try { await service.recordTaskResult({ taskId: task.id, failed: true, result: { summary: 'The fictional repair lookup failed.' } }); } catch { /* Preserve a pending task if storage is unavailable. */ }
        return failed('repair_lookup_failed');
      }
      if (error instanceof CRMError) return failed(error.code);
      return { ...(catalog ?? await lookupRepair(args)), memory: unavailable() };
    }
  }
  async function parts(args) {
    if (ended) return failed('interaction_ended');
    if (!validate('check_parts', args)) return failed('invalid_arguments');
    if (!(await ready)) return unavailable();
    if (!context.crewId) return failed('profile_required');
    if (!context.caseId) return failed('case_required');
    let task;
    try {
      task = await service.startTask({ interactionId: context.interactionId, specialist: 'logistics', assignment: 'Check a compatible thermal regulator in the fictional catalog.' });
      const catalog = await lookupParts({ equipment_model: task.equipment_model });
      const recorded = await service.recordTaskResult({ taskId: task.id, failed: !catalog?.ok,
        result: catalog?.ok ? { summary: catalog.summary, source_id: catalog.source_id } : { summary: 'No compatible fictional part was found.' } });
      if (recorded.status === 'obsolete') return failed('obsolete_result');
      return { ...catalog, task_id: task.id, task_status: recorded.status };
    } catch (error) {
      if (task) {
        try { await service.recordTaskResult({ taskId: task.id, failed: true, result: { summary: 'The fictional parts check could not finish.' } }); } catch { return unavailable(); }
        return failed('parts_lookup_failed');
      }
      return error instanceof CRMError ? failed(error.code) : unavailable();
    }
  }
  return {
    ready,
    async startupInstruction() {
      return (await ready) ? 'Case memory is available. No demo profile is loaded. Ask the caller for their authorization phrase.' : unavailable().message;
    },
    handle(name, args) {
      if (name === 'lookup_repair') return repair(args);
      if (name === 'check_parts') return parts(args);
      return serialize(async () => {
        if (ended) return failed('interaction_ended');
        if (!CRM_TOOLS.some(t => t.name === name)) return failed('unsupported_tool');
        if (!validate(name, args)) return failed('invalid_arguments');
        if (!(await ready)) return unavailable();
        try {
          if (name === 'load_crew_profile') {
            const result = await service.loadProfileByAuthCode({ spokenCode: args.spoken_code, candidateIds: context.candidateIds, interactionId: context.interactionId });
            if (!result.ok) return result;
            context.crewId = result.crewId; context.profile = result.profile;
            const count = result.profile.open_cases.length;
            const loaded = { ok: true, state: 'demo profile loaded', ...result.profile,
              crm_context: await service.getInteractionContext({ interactionId: context.interactionId }),
              next_action: count > 1 ? 'Ask which open case the caller wants to continue, or whether this is a new issue.' :
                count === 1 ? 'Ask whether this call is about the open case before resuming it.' : result.profile.recent_cases.length ? 'Ask whether the caller wants to review a recent issue or open a new case. Use review_case only after confirmation.' : 'Ask about the new issue and open a case when requested.' };
            if (!context.callbackTaskId) return loaded;
            // A return call reveals its result only to the profile that queued it, and only after the case is confirmed.
            let reply = null;
            try { reply = await service.prepareTaskReply(context.callbackTaskId); } catch { reply = null; }
            if (!reply || reply.crewId !== result.crewId) return { ...loaded, callback: { matched: false }, next_action: 'This return call is not for the loaded profile. Offer general fictional help only; do not mention any case.' };
            return { ...loaded, callback: { matched: true, case_id: reply.caseId, task_id: reply.taskId, specialist: reply.specialist, result: reply.body },
              next_action: `This is a return call about case ${reply.caseId}. Confirm the caller wants to continue it, resume it, then share the ${reply.specialist} result.` };
          }
          if (!context.crewId) return failed('profile_required');
          if (name === 'get_crm_context') return { ok: true, crm_context: await service.getInteractionContext({ interactionId: context.interactionId }) };
          if (name === 'resume_case' || name === 'review_case' || name === 'open_case') {
            const result = name !== 'open_case' ? await service.attachInteraction({ interactionId: context.interactionId, caseId: args.case_id, callerConfirmed: args.caller_confirmed, reviewOnly: name === 'review_case' }) :
              await service.openCase({ interactionId: context.interactionId, equipmentId: args.equipment_id, symptom: args.symptom });
            context.caseId = result.caseId;
            return { ok: true, ...result, crm_context: await service.getInteractionContext({ interactionId: context.interactionId }) };
          }
          if (!context.caseId) return failed('case_required');
          if (name === 'request_repair_sms') {
            if (!smsFollowup) return failed('sms_unavailable');
            return await smsFollowup.request({ interactionId: context.interactionId, fromE164: context.fromE164, explicitRequest: args.caller_requested, confirmedDestination: args.caller_confirmed_destination });
          }
          if (name === 'route_request') {
            if (!decisionStep) return failed('decisions_unavailable');
            const decision = await decisionStep.evaluate({ interactionId: context.interactionId, profile: context.profile, request: args.request });
            if (decision.task && !decision.reused) context.queuedTaskIds = [...(context.queuedTaskIds ?? []), decision.task.id];
            return { ok: true, outcome: decision.outcome, reason: decision.reason, route: decision.route, urgency: decision.urgencyLabel,
              task_id: decision.task?.id ?? null, callback_owner: decision.task?.specialist ?? null, reused: decision.reused ?? false,
              solution: decision.solution ?? null, ...reportingAction(decision) };
          }
          if (name === 'request_reply') {
            const task = await service.recordReplyConsent({ interactionId: context.interactionId, taskId: args.task_id, channel: args.channel, fromE164: context.fromE164, explicitRequest: args.caller_requested, confirmedDestination: args.caller_confirmed_destination });
            if (task.status === 'result_ready' && onReplyRequested) {
              try { await onReplyRequested(task.id); } catch { /* Consent persists; a due reply can be swept later. */ }
            }
            return { ok: true, task_id: task.id, channel: task.reply_channel, status: task.status, callback_owner: task.reply_channel === 'voice' ? task.specialist : null, message: 'Reply requested for the number the caller is using. Check the recorded outcome before claiming it was sent or delivered.' };
          }
          if (name === 'update_symptom') await service.updateSymptom({ interactionId: context.interactionId, symptom: args.symptom });
          if (name === 'record_repair_outcome') await service.recordDiagnosisOutcome({ interactionId: context.interactionId, outcome: args.outcome, callerConfirmed: args.caller_confirmed });
          if (name === 'close_case') await service.closeCase({ interactionId: context.interactionId, callerConfirmed: args.caller_confirmed });
          return { ok: true, caseId: context.caseId, brief: await service.getInteractionBrief(context.interactionId),
            crm_context: await service.getInteractionContext({ interactionId: context.interactionId }) };
        } catch (error) { return error instanceof CRMError ? failed(error.code) : unavailable(); }
      });
    },
    async end() {
      if (ended) return;
      ended = true;
      await ready;
      await queue;
      if (context.interactionId) {
        try { await service.endInteraction(context.interactionId); } catch { /* No invented persistence success. */ }
      }
    },
  };
}
