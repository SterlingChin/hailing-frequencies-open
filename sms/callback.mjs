import twilio from 'twilio';
import { CRMError } from '../crm/service.mjs';

const statuses = { accepted: 'submitted', scheduled: 'queued', queued: 'queued', sending: 'submitted', sent: 'sent', delivered: 'delivered', failed: 'failed', undelivered: 'undelivered', canceled: 'failed' };
export function createSmsCallback({ service, config }) {
  return async (req, res) => {
    const match = /^\/sms\/status\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.exec(req.url ?? '');
    if (!match || req.method !== 'POST') return false;
    const reply = code => { res.writeHead(code, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' }); res.end(code === 204 ? undefined : 'Callback rejected.'); return true; };
    if (!service || !config.authToken || !config.publicOrigin || !config.accountSid) return reply(503);
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') return reply(415);
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384) return reply(413);
        chunks.push(chunk);
      }
      const params = Object.create(null);
      for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
        if (Object.hasOwn(params, key)) return reply(400);
        params[key] = value;
      }
      const signature = req.headers['x-twilio-signature'];
      if (typeof signature !== 'string' || !twilio.validateRequest(config.authToken, signature, `${config.publicOrigin}${req.url}`, params) ||
        params.AccountSid !== config.accountSid || !/^SM[0-9a-f]{32}$/i.test(params.MessageSid ?? '')) return reply(403);
      if (!Object.hasOwn(statuses, params.MessageStatus)) return reply(400);
      const record = await service.getMessageForCallback(match[1]);
      await service.recordMessageStatus({ messageId: record.id, providerSid: params.MessageSid, status: statuses[params.MessageStatus], errorCode: params.ErrorCode || null });
      return reply(204);
    } catch (error) {
      return reply(error instanceof CRMError ? (error.code === 'not_found' ? 404 : 409) : 503);
    }
  };
}
