import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import twilio from 'twilio';
import WebSocket, { WebSocketServer } from 'ws';
import { createCallTools } from '../crm/tools.mjs';
import { attachBridge } from './bridge.mjs';
import { sessionConfig, lookupRepair, WELCOME, CALLBACK_WELCOME } from './config.mjs';

const safeCallId = value => /^CA[0-9a-f]{32}$/i.test(value || '');
const E164 = /^\+[1-9]\d{1,14}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const TICKET = /^[a-f0-9]{48}$/;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  /^[a-f0-9]{48}$/.test(a) && /^[a-f0-9]{48}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createModelSocket(config) {
  return new WebSocket('wss://api.openai.com/v1/live/sessions', {
    headers: { Authorization: `Bearer ${config.openaiKey}` },
    handshakeTimeout: 10000, maxPayload: 1024 * 1024, followRedirects: false,
  });
}
export function createVoiceServer({ config, modelFactory = () => createModelSocket(config), onSummary = () => {}, bridgeOptions = {}, crmService = null, handleRequest = async () => false, smsFollowup = null, decisionStep = null, onReplyRequested = null }) {
  const voiceEnabled = config.voiceEnabled !== false;
  if (voiceEnabled && !config.publicOrigin?.startsWith('https://')) throw new Error('A canonical HTTPS origin is required.');
  const streamURL = `${config.publicOrigin?.replace(/^https:/, 'wss:')}/media-stream/`;
  const callLimit = config.callLimit ?? 1;
  const pending = new Map();
  const callbacks = new Map(); // one-time outbound tickets: nonce → { taskId, to, expires }
  let bridge, activeSocket, bridgeActive = false, callsStarted = 0;
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  function reject(res, status) { res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Request rejected.'); }
  const server = http.createServer(async (req, res) => {
    try {
      if (await handleRequest(req, res)) return;
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ status: 'ready', voiceEnabled, callsStarted, callLimit }));
      }
      if (!voiceEnabled) return reject(res, 404);
      const url = new URL(req.url, config.publicOrigin);
      const outbound = url.pathname === '/outbound-call';
      if (req.method !== 'POST' || (!outbound && req.url !== '/incoming-call')) return reject(res, 404);
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return reject(res, 415);
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 16384) { reject(res, 413); req.destroy(); return; } chunks.push(chunk); }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const params = Object.create(null);
      for (const [k, v] of form) { if (Object.hasOwn(params, k)) return reject(res, 400); params[k] = v; }
      // Twilio signs the exact URL it fetched, query string included.
      const ticketId = outbound ? url.searchParams.get('ticket') : null;
      if (outbound && (!TICKET.test(ticketId ?? '') || [...url.searchParams.keys()].length !== 1)) return reject(res, 403);
      const signedURL = outbound ? `${config.publicOrigin}/outbound-call?ticket=${ticketId}` : `${config.publicOrigin}/incoming-call`;
      const signature = req.headers['x-twilio-signature'];
      if (typeof signature !== 'string' || !twilio.validateRequest(config.authToken, signature, signedURL, params) ||
          params.AccountSid !== config.accountSid || !safeCallId(params.CallSid)) return reject(res, 403);
      let callback = null;
      if (outbound) {
        callback = callbacks.get(ticketId);
        callbacks.delete(ticketId);
        if (!callback || callback.expires < Date.now() || params.To !== callback.to) return reject(res, 403);
      }
      const response = new twilio.twiml.VoiceResponse();
      if (callsStarted >= callLimit || activeSocket || bridgeActive) {
        if (outbound) { response.say('Federation Customer Service is busy. We will try again shortly.'); response.hangup(); }
        else response.reject({ reason: 'busy' });
      } else {
        const now = Date.now();
        for (const [id, entry] of pending) if (entry.expires < now) pending.delete(id);
        if (pending.size >= 20 && !pending.has(params.CallSid)) return reject(res, 429);
        const entry = pending.get(params.CallSid) || { nonce: randomBytes(24).toString('hex'), expires: now + 60000, callSid: params.CallSid,
          fromE164: outbound ? callback.to : E164.test(params.From || '') ? params.From : null, callbackTaskId: callback?.taskId ?? null };
        pending.set(params.CallSid, entry);
        response.connect().stream({ url: streamURL }).parameter({ name: 'ticket', value: entry.nonce });
        response.hangup();
      }
      res.writeHead(200, { 'Content-Type': 'text/xml', 'Cache-Control': 'no-store' }); res.end(response.toString());
    } catch { if (!res.headersSent) reject(res, 400); else res.end(); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.on('upgrade', (req, socket, head) => {
    const signature = req.headers['x-twilio-signature'];
    if (!voiceEnabled || req.url !== '/media-stream/' || typeof signature !== 'string' ||
        !twilio.validateRequest(config.authToken, signature, streamURL, {}) || callsStarted >= callLimit || activeSocket || bridgeActive) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    websocketServer.handleUpgrade(req, socket, head, ws => {
      activeSocket = ws;
      const timer = setTimeout(() => ws.close(1008, 'Start required'), 5000);
      ws.on('error', () => {});
      ws.once('close', () => { clearTimeout(timer); if (activeSocket === ws) activeSocket = undefined; });
      let connectedSeen = false;
      const gate = (raw, isBinary) => {
        let message;
        if (isBinary) { ws.close(1008, 'Invalid frame'); return; }
        try { message = JSON.parse(raw.toString()); } catch { ws.close(1008, 'Invalid frame'); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { ws.close(1008, 'Invalid frame'); return; }
        if (message.event === 'connected' && !connectedSeen) { connectedSeen = true; return; }
        const start = message.start, entry = pending.get(start?.callSid);
        if (message.event !== 'start' || !entry || entry.expires < Date.now() || start.accountSid !== config.accountSid ||
            !equal(start.customParameters?.ticket, entry.nonce)) { ws.close(1008, 'Invalid start'); return; }
        pending.delete(start.callSid); callsStarted++; clearTimeout(timer); ws.off('message', gate);
        const context = { callSid: entry.callSid, fromE164: entry.fromE164, candidateIds: [], crewId: null, caseId: null, profile: null, callbackTaskId: entry.callbackTaskId ?? null };
        const callTools = createCallTools({ service: crmService, context, lookupRepair, smsFollowup, decisionStep, onReplyRequested });
        bridgeActive = true;
        bridge = attachBridge(ws, { ...bridgeOptions, createModelSocket: modelFactory, sessionConfig: sessionConfig(), lookupRepair, callTools,
          welcome: context.callbackTaskId ? CALLBACK_WELCOME : WELCOME, maxSessionMs: config.maxSessionMs ?? 120000 });
        bridge.done.finally(() => { bridgeActive = false; }).then(onSummary).catch(() => {});
        ws.emit('message', raw, false);
      };
      ws.on('message', gate);
    });
  });
  /** One-time ticket for an outbound reply call. Expires in ten minutes; at most twenty outstanding. */
  function registerCallback({ taskId, to }) {
    if (!voiceEnabled) throw new Error('Voice is disabled.');
    if (!UUID.test(taskId ?? '') || !E164.test(to ?? '')) throw new Error('Invalid callback.');
    const now = Date.now();
    for (const [id, entry] of callbacks) if (entry.expires < now) callbacks.delete(id);
    if (callbacks.size >= 20) throw new Error('Too many pending callbacks.');
    const nonce = randomBytes(24).toString('hex');
    callbacks.set(nonce, { taskId, to, expires: now + 600000 });
    return { ticket: nonce, url: `${config.publicOrigin}/outbound-call?ticket=${nonce}` };
  }
  return { server, registerCallback, get callsStarted() { return callsStarted; },
    async close() {
      if (bridge) { bridge.stop(); await bridge.done; }
      for (const ws of websocketServer.clients) ws.terminate();
      websocketServer.close();
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}
// Preserve the old direct entry point while using the same application wiring.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  import('../app/server.mjs').then(({ main }) => main()).catch(() => {
    console.error('Application could not start. Check environment configuration; private details are withheld.');
    process.exitCode = 1;
  });
}
