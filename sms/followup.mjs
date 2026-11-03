import twilio from 'twilio';
import { CRMError } from '../crm/service.mjs';

export function createTwilioSender(config) {
  // Constructing the SDK sends nothing. Disable automatic retries: an ambiguous
  // POST outcome must never silently create a second text.
  const client = twilio(config.accountSid, config.authToken, { autoRetry: false, timeout: 8000 });
  return ({ to, body, statusCallback }) => client.messages.create({ to, body, from: config.smsFrom, statusCallback });
}
/** Send one claimed message exactly once and record what the provider said. Shared by the repair follow-up and the specialist reply. */
export async function deliverClaimedMessage({ service, config, send, message, to, body, label = 'repair summary' }) {
  let response;
  try {
    response = await send({ to, body, statusCallback: `${config.publicOrigin}/sms/status/${message.id}` });
  } catch (error) {
    // Only a definite client rejection is a known failure. Timeout/network/5xx
    // can mean accepted; keep the durable claim and wait for a signed callback.
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      const code = /^\d{1,8}$/.test(String(error.code)) ? String(error.code) : null;
      const failed = await service.recordMessageStatus({ messageId: message.id, status: 'failed', errorCode: code });
      return { message: failed, reason: `SMS failed. The ${label} remains available on screen.` };
    }
    return { message, reason: `Delivery not confirmed. The send outcome is unknown; use the ${label} on screen. No automatic retry.` };
  }
  if (!/^SM[0-9a-f]{32}$/i.test(response?.sid ?? '')) return { message, reason: `Delivery not confirmed. Use the ${label} on screen.` };
  try {
    const submitted = await service.recordMessageStatus({ messageId: message.id, status: 'submitted', providerSid: response.sid });
    return { message: submitted, reason: submitted.status === 'delivered' ? 'Delivery confirmed by a recorded callback.' : `${label[0].toUpperCase()}${label.slice(1)} submitted. Delivery not confirmed.` };
  } catch {
    return { message, reason: 'Delivery not confirmed. The send was attempted but its result could not be saved. No automatic retry.' };
  }
}
export function createSmsFollowup({ service, config, send }) {
  return {
    async request({ interactionId, fromE164, explicitRequest, confirmedDestination }) {
      if (explicitRequest !== true || confirmedDestination !== true) throw new CRMError('message_request_required');
      const summary = await service.prepareRepairFollowup({ interactionId, fromE164 });
      const view = (message, reason) => ({ ok: true, channel: 'sms', status: message?.status ?? 'unavailable',
        summary: summary.body, destination_label: summary.destinationLabel,
        fallback: true, message: reason });
      if (!summary.contactPointId) return view(null, 'No eligible caller contact. Read the repair summary here. Nothing was sent.');
      const message = await service.requestMessage({ interactionId, contactPointId: summary.contactPointId, body: summary.body,
        idempotencyKey: summary.idempotencyKey, explicitRequest: true });
      if (!config.smsEnabled || !send) return view(message, 'SMS is unavailable. Keep the repair summary on screen. Nothing was sent.');
      const claim = await service.claimMessageSend(message.id);
      if (!claim.claimed) return view(claim.message, claim.message.status === 'delivered' ? 'Delivery confirmed by a recorded callback.' : 'A send was already attempted. Check the recorded status; no duplicate was sent.');
      const delivered = await deliverClaimedMessage({ service, config, send, message: claim.message, to: summary.to, body: summary.body });
      return view(delivered.message, delivered.reason);
    },
  };
}
