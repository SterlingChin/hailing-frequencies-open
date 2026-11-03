import { speakingPreference } from './language.mjs';
import { randomBytes } from 'node:crypto';
import { createInteraction, editReport } from './reporting.mjs';
import { liveConfig, startLive } from './live.mjs';
import { createRehearsalBridge, rehearsalConfig } from './rehearsal-bridge.mjs';

import { createCallerContext } from './caller-context.mjs';
import { createExpertRouter } from './expert-mcp.mjs';
import { createSnapshotWriter } from './events.mjs';
import { createDebugFetch } from './debug.mjs';
import { createCRMClient } from './crm-context.mjs';

export function createApi({ env = process.env, createLive = startLive, createBridge = createRehearsalBridge, contextClient = null, crmClient = null, expertRouter = null } = {}) {
  const config = liveConfig(env), rehearsal = createBridge({ config: rehearsalConfig(env) }), sessions = new Map(), streams = new WeakMap();
  const publicState = session => ({
    crew: session.state.profile ?? null, identityStatus: session.state.identityStatus ?? 'idle', ...Object.fromEntries(['authorized', 'attempts', 'mode', 'active', 'liveStatus', 'channelId'].map(key => [key, session.state[key]])),
    report: session.reports.get(session.selectedReportId)?.report ?? null,
    hasCurrentReport: Boolean(session.state.report),
    reports: [...session.reports.values()].map(({ report }) => ({ id: report.id, createdAt: report.createdAt, issue: report.issue.slice(0, 80) })),
    liveConfigured: config.enabled,
    preferredLanguage: speakingPreference(session.state.profile).language, liveVoice: session.state.liveVoice || 'marin',
    voiceSwitchPending: Boolean(session.state.authorized && speakingPreference(session.state.profile).voice !== (session.state.liveVoice || 'marin')),
    crmContext: session.state.crmContext ?? null, decision: session.state.decision ?? null, expert: session.state.expert ?? null,
    debugResponses: session.state.debugResponses ?? [], debugDropped: session.state.debugDropped ?? 0,
    contextStatus: session.state.contextStatus ?? 'idle', contextUpdatedAt: session.state.contextUpdatedAt ?? null,
  });
  function publish(session) {
    if (session.state.report && session.lastCapturedVersion !== session.state.report.updatedAt) {
      session.reports.set(session.state.report.id, session.state);
      // Keep recent recaps bounded without preventing new conversations.
      while (session.reports.size > 100) session.reports.delete(session.reports.keys().next().value);
      session.selectedReportId = session.state.report.id;
      session.lastCapturedVersion = session.state.report.updatedAt;
    }
    const message = `data: ${JSON.stringify(publicState(session))}\n\n`;
    for (const res of session.listeners) {
      if (res.writableEnded || res.destroyed) session.listeners.delete(res);
      else streams.get(res)?.write(message);
    }
  }
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) if (!session.state.active && Date.now() - session.touched > 3600000) {
      session.live?.stop(); void session.rehearsal?.end(); for (const res of session.listeners) res.end(); sessions.delete(id);
    }
  }, 60000);
  cleanup.unref();
  function json(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(JSON.stringify(body));
  }
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON.');
    let value = '';
    for await (const chunk of req) {
      value += chunk;
      if (Buffer.byteLength(value) > 128 * 1024) throw new Error('Request too large.');
    }
    const result = JSON.parse(value);
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Expected a JSON object.');
    return result;
  }
  async function handle(req, res) {
    const path = req.url.split('?')[0];
    if (path === '/health' && req.method === 'GET') {
      json(res, 200, { status: 'ready', service: 'reporting-ui', liveEnabled: config.enabled, externalDeliveryEnabled: false }); return true;
    }
    if (!path.startsWith('/api/')) return false;
    const origin = env.PUBLIC_ORIGIN || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    if (req.method !== 'GET' && req.headers.origin !== origin) { json(res, 403, { error: 'Origin rejected.' }); return true; }
    const cookieId = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('hf_demo='))?.slice(8);
    let session = sessions.get(cookieId);
    if (!session && path === '/api/session' && req.method === 'GET') {
      if (sessions.size >= 1000) { json(res, 503, { error: 'Service capacity reached.' }); return true; }
      const id = randomBytes(32).toString('hex');
      session = { csrf: randomBytes(32).toString('hex'), state: createInteraction(), listeners: new Set(), reports: new Map(), cancelledChannels: new Set(), touched: Date.now(), live: null };
      sessions.set(id, session);
      res.setHeader('Set-Cookie', `hf_demo=${id}; HttpOnly; SameSite=Strict; Path=/${origin.startsWith('https://') ? '; Secure' : ''}`);
    }
    if (!session) { json(res, 401, { code: 'browser_session_reset', error: 'Reconnecting to the app. Try Engage again.' }); return true; }
    session.touched = Date.now();
    if (path === '/api/session' && req.method === 'GET') { json(res, 200, { ...publicState(session), csrf: session.csrf }); return true; }
    if (path === '/api/rehearsal' && req.method === 'GET') {
      json(res, rehearsal ? 200 : 404, rehearsal ? { enabled: true, ...(session.rehearsal?.public() ?? { active: false, context: null, decision: null, timeline: [] }) }
        : { error: 'Real-data rehearsal is not configured.' }); return true;
    }
    if (path === '/api/events' && req.method === 'GET') {
      if (session.listeners.size >= 3) { json(res, 429, { error: 'Too many open screens.' }); return true; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const writer = createSnapshotWriter(res); streams.set(res, writer);
      session.listeners.add(res); publish(session);
      const heartbeat = setInterval(() => writer.heartbeat(), 15000);
      res.on('close', () => { clearInterval(heartbeat); session.listeners.delete(res); });
      return true;
    }
    if (req.method !== 'POST') { json(res, 404, { error: 'Not found.' }); return true; }
    if (req.headers['x-csrf-token'] !== session.csrf) { json(res, 403, { error: 'Session token rejected. Reload this page.' }); return true; }
    let args;
    try { args = await body(req); } catch { json(res, 400, { error: 'Invalid or oversized JSON request.' }); return true; }
    try {
      if (path === '/api/reset') {
        const previous = session.state, live = session.live, priorRehearsal = session.rehearsal;
        previous.active = false;
        for (const listener of session.listeners) listener.end();
        session.listeners.clear();
        session.state = createInteraction();
        session.reports.clear(); session.selectedReportId = null; session.lastCapturedVersion = null;
        session.cancelledChannels.clear(); session.conversation = {}; session.clients = null;
        session.live = null; session.rehearsal = null; session.switching = false;
        session.csrf = randomBytes(32).toString('hex');
        live?.stop(); void priorRehearsal?.end().catch(() => {});
        json(res, 200, { ...publicState(session), csrf: session.csrf }); return true;
      }
      if (path === '/api/rehearsal') {
        if (!rehearsal) { json(res, 404, { error: 'Real-data rehearsal is not configured.' }); return true; }
        const current = session.rehearsal;
        if (args.action === 'start') {
          if (current?.active) { json(res, 409, { error: 'End the current rehearsal before starting another.' }); return true; }
          session.rehearsal = await rehearsal.start();
        } else if (args.action === 'end') {
          session.live?.stop(); await current?.end();
        } else {
          if (!current?.active) { json(res, 409, { error: 'Start an Avery rehearsal first.' }); return true; }
          let name, toolArgs;
          if (args.action === 'select_case' && /^HF-\d{3,12}$/.test(args.case_id ?? '') && args.caller_confirmed === true) {
            name = args.review_only === true ? 'review_case' : 'resume_case'; toolArgs = { case_id: args.case_id, caller_confirmed: true };
          } else if (args.action === 'open_case' && typeof args.equipment_id === 'string' && typeof args.symptom === 'string') {
            name = 'open_case'; toolArgs = { equipment_id: args.equipment_id, symptom: args.symptom };
          } else if (args.action === 'update_symptom' && typeof args.symptom === 'string') {
            name = 'update_symptom'; toolArgs = { symptom: args.symptom };
          } else if (args.action === 'decide' && typeof args.request === 'string' && args.request.trim()) {
            name = 'route_request'; toolArgs = { request: args.request };
          } else if (args.action === 'refresh') { name = 'get_crm_context'; toolArgs = {}; }
          else if (args.action === 'outcome' && ['confirmed_fixed', 'not_fixed'].includes(args.outcome) && args.caller_confirmed === true) {
            name = 'record_repair_outcome'; toolArgs = { outcome: args.outcome, caller_confirmed: true };
          } else if (args.action === 'close_case' && args.caller_confirmed === true) {
            name = 'close_case'; toolArgs = { caller_confirmed: true };
          } else { json(res, 400, { error: 'Invalid rehearsal action.' }); return true; }
          const result = await current.call(name, toolArgs);
          if (!result.ok) { json(res, 409, { error: result.error?.code ?? 'backend_unavailable', ...current.public() }); return true; }
        }
        json(res, 200, { enabled: true, ...session.rehearsal?.public() }); return true;
      }
      if (path === '/api/begin') {
        if (args.channelId !== undefined && (typeof args.channelId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(args.channelId))) { json(res, 400, { error: 'Invalid channel identifier.' }); return true; }
        if (session.cancelledChannels.has(args.channelId)) { json(res, 409, { error: 'Channel creation cancelled.' }); return true; }
        if (args.mode !== 'live') { json(res, 400, { error: 'Only GPT-Live channels are supported.' }); return true; }
        if (session.switching || session.state.active || ['closing', 'connecting'].includes(session.state.liveStatus)) { json(res, 409, { error: 'End the current channel before engaging again.' }); return true; }
        if (args.mode === 'live') {
          if (!config.enabled) { json(res, 503, { error: 'Live is not configured on this server.' }); return true; }
          if (typeof args.sdp !== 'string' || !args.sdp.trim() || args.sdp.length > 100000) { json(res, 400, { error: 'Invalid WebRTC offer.' }); return true; }
        }
        session.live = null; session.conversation = {};
        session.state = createInteraction(); session.state.mode = args.mode; session.state.active = true;
        session.state.channelId = args.channelId || randomBytes(16).toString('hex');
        session.lastCapturedVersion = null;
        const ownedState = session.state;
        if (session.rehearsal?.active) ownedState.authorized = true;
        ownedState.offer = args.sdp;
        const notify = () => {
          if (session.state === ownedState) publish(session);
        };
        const debugFetch = createDebugFetch({ state: ownedState, notify, secrets: [env.OPENAI_API_KEY, env.CONTEXT_API_TOKEN, env.REPORTING_API_TOKEN, env.SPECIALISTS_MCP_TOKEN] });
        session.clients = { fetchImpl: debugFetch, contextClient: contextClient || createCallerContext({ env, fetchImpl: debugFetch }), crmClient: crmClient || createCRMClient({ env, fetchImpl: debugFetch }), expertRouter: expertRouter || createExpertRouter({ env, fetchImpl: debugFetch }) };
        const cancelled = () => { if (!res.writableFinished) { ownedState.active = false; if (session.state === ownedState) session.live?.stop(); } };
        res.once('close', cancelled);
        try {
          const live = await createLive({ state: ownedState, apiKey: config.apiKey, backendModel: config.backendModel, ...session.clients, conversation: session.conversation, notify,
            backend: session.rehearsal?.active ? session.rehearsal : null });
          delete ownedState.offer;
          if (!ownedState.active || session.state !== ownedState) {
            live.stop(); json(res, 409, { error: 'Channel creation cancelled.' }); return true;
          }
          session.live = live;
          json(res, 200, { ...publicState(session), sdp: live.sdp });
        } catch (error) {
          ownedState.active = false; ownedState.liveStatus = 'failed'; delete ownedState.offer; publish(session);
          json(res, 502, { error: error.message });
        } finally { res.off('close', cancelled); }
        return true;
      }
      if (path === '/api/live/voice') {
        if (args.channelId !== session.state.channelId || !session.state.active || !session.state.authorized || !session.conversation?.identity?.valid() || session.switching || !session.live?.retireForVoiceChange) { json(res, 409, { error: 'The channel could not change voice.' }); return true; }
        if (typeof args.sdp !== 'string' || !args.sdp.trim() || args.sdp.length > 100000) { json(res, 400, { error: 'Invalid WebRTC offer.' }); return true; }
        if (speakingPreference(session.state.profile).voice === session.state.liveVoice) { json(res, 409, { error: 'The preferred voice is already active.' }); return true; }
        session.switching = true;
        const ownedState = session.state, ownedLive = session.live;
        const cancelled = () => { if (!res.writableFinished) { ownedState.active = false; ownedLive.stop(); } };
        res.once('close', cancelled);
        try {
          if (!await ownedLive.retireForVoiceChange() || !ownedState.active) { ownedLive.stop(); json(res, 409, { error: 'Channel change cancelled.' }); return true; }
          ownedState.offer = args.sdp;
          const voice = await createLive({ state: ownedState, apiKey: config.apiKey, backendModel: config.backendModel, ...session.clients, conversation: session.conversation, notify: () => { if (session.state === ownedState) publish(session); } });
          delete ownedState.offer;
          if (!ownedState.active || session.state !== ownedState) { voice.stop(); json(res, 409, { error: 'Channel change cancelled.' }); return true; }
          session.live = voice; publish(session); json(res, 200, { ...publicState(session), sdp: voice.sdp });
        } catch { ownedState.active = false; ownedState.liveStatus = 'failed'; ownedLive.stop(); if (session.state === ownedState) publish(session); json(res, 502, { error: 'Could not connect the preferred voice. Try Engage again.' }); }
        finally { delete ownedState.offer; session.switching = false; res.off('close', cancelled); }
        return true;
      }
      if (path === '/api/stop') {
        if (typeof args.channelId === 'string') {
          session.cancelledChannels.add(args.channelId);
          if (session.cancelledChannels.size > 100) session.cancelledChannels.delete(session.cancelledChannels.values().next().value);
          if (args.channelId !== session.state.channelId) { json(res, 200, publicState(session)); return true; }
        }
        session.state.active = false;
        session.live?.stop(); publish(session); json(res, 200, publicState(session)); return true;
      }
      if (path === '/api/live/ready' && session.live && session.state.active) {
        if (args.channelId && args.channelId !== session.state.channelId) { json(res, 409, { error: 'This channel has ended.' }); return true; }
        session.live.ready(); json(res, 200, publicState(session)); return true;
      }
      if (path === '/api/context/refresh') {
        if (!session.state.active || !session.state.authorized || !session.live?.refreshContext) { json(res, 409, { error: 'Open and authorize a channel to refresh context.' }); return true; }
        const result = await session.live.refreshContext();
        if (!result.ok) { json(res, 502, { error: 'Could not refresh case context.' }); return true; }
        publish(session); json(res, 200, publicState(session)); return true;
      }
      if (path === '/api/report') {
        const reportState = session.reports.get(args.id || session.selectedReportId);
        if (!reportState) { json(res, 404, { error: 'This report is no longer available.' }); return true; }
        const result = editReport(reportState, args);
        if (!result.ok) { json(res, 400, { error: 'Confirm your identity and capture an issue before reviewing it.' }); return true; }
        publish(session); json(res, 200, publicState(session)); return true;
      }
      if (path === '/api/report/select') {
        if (!session.reports.has(args.id)) { json(res, 404, { error: 'Report not found.' }); return true; }
        session.selectedReportId = args.id;
        publish(session); json(res, 200, publicState(session)); return true;
      }
      json(res, 404, { error: 'Not found.' });
    } catch { json(res, 500, { error: 'The channel could not finish this action. Try again.' }); }
    return true;
  }
  return { handle, close: () => { clearInterval(cleanup); for (const session of sessions.values()) { session.live?.stop(); void session.rehearsal?.end(); for (const res of session.listeners) res.end(); } } };
}
