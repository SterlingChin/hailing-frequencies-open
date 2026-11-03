import { CRMError } from '../crm/service.mjs';
import { deliverClaimedMessage } from '../sms/followup.mjs';

/** Text a specialist result back to the number the caller consented to on the original call. */
export function createSmsReply({ service, config, send = null }) {
  return {
    async deliver({ taskId }) {
      const prep = await service.prepareTaskReply(taskId);
      if (prep.channel !== 'sms') throw new CRMError('reply_channel_mismatch');
      const view = (message, reason) => ({ ok: true, channel: 'sms', task_id: taskId, status: message?.status ?? 'unavailable',
        destination_label: prep.destinationLabel, summary: prep.body, message: reason });
      if (!config.smsEnabled || !send) return view(null, 'SMS is unavailable. Nothing was sent; the result stays on the case.');
      const claim = await service.claimTaskReply(taskId);
      if (!claim.claimed) return view({ status: claim.task.reply_outcome ?? 'claimed' }, 'A text was already attempted. Check the recorded outcome; no duplicate was sent.');
      const i = await service.beginReplyInteraction(taskId);
      let outcome = 'unavailable', latest = null;
      try {
        latest = await service.requestMessage({ interactionId: i.id, contactPointId: prep.contactPointId, body: prep.body, idempotencyKey: prep.idempotencyKey, explicitRequest: true });
        const sendClaim = await service.claimMessageSend(latest.id);
        latest = sendClaim.message;
        if (!sendClaim.claimed) return view(latest, 'A send was already attempted. Check the recorded status; no duplicate was sent.');
        const delivered = await deliverClaimedMessage({ service, config, send, message: latest, to: prep.to, body: prep.body, label: 'result' });
        latest = delivered.message;
        outcome = latest.status === 'failed' ? 'failed' : latest.provider_sid ? 'submitted' : 'unavailable';
        return view(latest, delivered.reason);
      } finally {
        try { await service.recordTaskReplyOutcome({ taskId, outcome, providerSid: latest?.provider_sid ?? null }); } catch { /* Keep the claim; never resend to fix bookkeeping. */ }
        try { await service.endInteraction(i.id); } catch { /* Outbound interaction stays open in history. */ }
      }
    },
  };
}
