import { CRM_TOOLS, MEMORY_INSTRUCTIONS } from '../crm/tools.mjs';

export const WELCOME = 'Channel open. I am your AI support officer. Please give your fictional authorization phrase.';
export const CALLBACK_WELCOME = 'Channel open. This is Federation Customer Service returning your call about your request. Before I share anything, please give your fictional authorization phrase.';
export const REPAIR_TOOL = {
  type: 'function', name: 'lookup_repair', strict: true,
  description: 'Look up an authored fictional Federation replicator repair procedure. This does not operate real equipment.',
  parameters: { type: 'object', additionalProperties: false,
    properties: { equipment_model: { type: 'string' }, symptom: { type: 'string' } },
    required: ['equipment_model', 'symptom'] },
};
export function lookupRepair(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some(k => !['equipment_model', 'symptom'].includes(k)) ||
      typeof args.equipment_model !== 'string' || typeof args.symptom !== 'string' ||
      args.equipment_model.length > 80 || args.symptom.length > 300) {
    return { ok: false, error: { code: 'invalid_repair_arguments' } };
  }
  if (!['RPL-7', 'RPL-2400'].includes(args.equipment_model.toUpperCase().trim()) || !/cold|lukewarm|not hot/i.test(args.symptom)) {
    return { ok: false, error: { code: 'procedure_not_found' }, next_action: 'Ask for the model and symptom; do not invent a procedure.' };
  }
  const model = args.equipment_model.toUpperCase().trim();
  return { ok: true, fictional: true, source_id: model === 'RPL-7' ? 'federation-demo-rpl7-cold-001' : 'federation-demo-rpl2400-cold-001', equipment_model: model,
    diagnosis: 'The fictional thermal calibration profile may be stale.',
    steps: ['Open the replicator diagnostic panel.', 'Run the beverage thermal calibration cycle.',
      'Replicate a test cup of coffee and report whether it is hot.'],
    next_action: 'If the test cup is still cold, consult Engineering. This lookup does not place or change part orders.' };
}
export function sessionConfig() {
  return {
    model: 'gpt-live-1', store: false,
    audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } },
    instructions: `You are a concise AI Federation support officer in a fictional demo. Ask one question at a time. Listen when interrupted. Explain imaginary repairs only. Delegate repair questions to the backend and wait for its actual result. Keep answers to two short sentences. ${MEMORY_INSTRUCTIONS}`,
    delegation: { type: 'responses', responses: {
      model: 'gpt-6-luna', reasoning: { effort: 'none' }, max_output_tokens: 512,
      instructions: `Use the CRM tools to load a profile, select a case and record corrections. For a repair question, call lookup_repair with the actual equipment model and reported symptom. For a compatible-part question, call check_parts after selecting the case; it checks fictional availability and places no order. For an access, maintenance or specialist request that the repair tools do not cover, call route_request with the caller's words after a case is selected, then follow its next_action. Report only the tool result. If it fails or finds nothing, say so and ask for clarification. All procedures are fictional. ${MEMORY_INSTRUCTIONS}`,
      tools: [REPAIR_TOOL, ...CRM_TOOLS], tool_choice: 'auto', parallel_tool_calls: false,
    } },
  };
}
export function loadConfig({ env = process.env } = {}) {
  const flag = name => {
    if (env[name] && !['true', 'false'].includes(env[name])) throw new Error(`Invalid variable: ${name}`);
    return env[name] === 'true';
  };
  const integer = (name, fallback, max) => {
    if (!env[name]) return fallback;
    if (!/^\d+$/.test(env[name]) || Number(env[name]) < 1 || Number(env[name]) > max) throw new Error(`Invalid variable: ${name}`);
    return Number(env[name]);
  };
  const voiceEnabled = flag('VOICE_ENABLED'), smsEnabled = flag('SMS_ENABLED'), decisionsEnabled = flag('DECISIONS_ENABLED'), callbackEnabled = flag('CALLBACK_ENABLED');
  if (callbackEnabled && !voiceEnabled) throw new Error('CALLBACK_ENABLED requires VOICE_ENABLED');
  const required = voiceEnabled || smsEnabled ? ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VOICE_PUBLIC_DOMAIN'] : [];
  if (voiceEnabled || decisionsEnabled) required.push('OPENAI_API_KEY');
  if (smsEnabled) required.push('TWILIO_SMS_FROM', 'DATABASE_URL');
  if (callbackEnabled) required.push('TWILIO_VOICE_FROM', 'DATABASE_URL');
  if (env.NODE_ENV === 'production') required.push('DATABASE_URL');
  if (env.CONTEXT_API_TOKEN && env.CONTEXT_API_TOKEN.length < 32) throw new Error('CONTEXT_API_TOKEN must be at least 32 characters.');
  if (env.REPORTING_API_TOKEN && !/^[\x21-\x7e]{32,256}$/.test(env.REPORTING_API_TOKEN)) throw new Error('REPORTING_API_TOKEN must contain 32–256 non-whitespace ASCII characters.');
  const missing = required.filter(k => !env[k]?.trim());
  if (missing.length) throw new Error(`Missing variables: ${missing.join(', ')}`);
  const domain = env.TWILIO_VOICE_PUBLIC_DOMAIN;
  let publicOrigin;
  if (domain) {
    const url = new URL(domain.includes('://') ? domain : `https://${domain}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('TWILIO_VOICE_PUBLIC_DOMAIN must be an HTTPS origin without a path.');
    }
    publicOrigin = url.origin;
  }
  if (smsEnabled && !/^\+[1-9]\d{1,14}$/.test(env.TWILIO_SMS_FROM)) throw new Error('TWILIO_SMS_FROM must be E.164.');
  if (callbackEnabled && !/^\+[1-9]\d{1,14}$/.test(env.TWILIO_VOICE_FROM)) throw new Error('TWILIO_VOICE_FROM must be E.164.');
  return { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN,
    openaiKey: env.OPENAI_API_KEY, publicOrigin, port: integer('PORT', 8788, 65535),
    host: env.HOST || (env.PORT || env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    voiceEnabled, smsEnabled, decisionsEnabled, callbackEnabled, smsFrom: env.TWILIO_SMS_FROM, voiceFrom: env.TWILIO_VOICE_FROM,
    callLimit: integer('VOICE_CALL_LIMIT', 1, 100), maxSessionMs: integer('VOICE_MAX_SESSION_SECONDS', 120, 600) * 1000,
    databaseUrl: env.DATABASE_URL || null, contextApiToken: env.CONTEXT_API_TOKEN || null,
    reportingApiToken: env.REPORTING_API_TOKEN || null };
}
