import twilio from 'twilio';
import { CRMError } from '../crm/service.mjs';

export function createTwilioCaller(config) {
  // Constructing the SDK sends nothing. No automatic retries: an ambiguous
  // POST outcome must never place a second call.
  const client = twilio(config.accountSid, config.authToken, { autoRetry: false, timeout: 8000 });
  return ({ to, url }) => client.calls.create({ to, from: config.voiceFrom, url, method: 'POST', timeout: 25 });
}

/**
 * Call the caller back with a specialist result. The placed call reaches the
 * same bridge through a one-time ticket; the officer still asks for the
 * authorization phrase before saying anything about the case.
 */
export function createCallReply({ service, config, place = null, registerCallback = null }) {
  return {
    async deliver({ taskId }) {
      const prep = await service.prepareTaskReply(taskId);
      if (prep.channel !== 'voice') throw new CRMError('reply_channel_mismatch');
      const view = (status, reason) => ({ ok: true, channel: 'voice', task_id: taskId, status, destination_label: prep.destinationLabel, summary: prep.body, message: reason });
      if (['it', 'maintenance'].includes(prep.specialist)) return view('unavailable', 'This reply requires the specialist-owned callback integration. The reporting agent has not placed a call; consent and the result remain on the task.');
      if (!config.callbackEnabled || !place || !registerCallback) return view('unavailable', 'Call back is unavailable. Nothing was placed; the result stays on the case.');
      const claim = await service.claimTaskReply(taskId);
      if (!claim.claimed) return view(claim.task.reply_outcome ?? 'claimed', 'A call back was already attempted. Check the recorded outcome; no duplicate was placed.');
      const ticket = registerCallback({ taskId, to: prep.to });
      let response;
      try { response = await place({ to: prep.to, url: ticket.url }); }
      catch (error) {
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
          try { await service.recordTaskReplyOutcome({ taskId, outcome: 'failed' }); } catch { /* claim retained */ }
          return view('failed', 'Call back failed. The result stays on the case.');
        }
        return view('unknown', 'Call back not confirmed. The placement outcome is unknown; no automatic retry.');
      }
      if (!/^CA[0-9a-f]{32}$/i.test(response?.sid ?? '')) return view('unknown', 'Call back not confirmed; no automatic retry.');
      try { await service.recordTaskReplyOutcome({ taskId, outcome: 'placed', providerSid: response.sid }); }
      catch { return view('unknown', 'Call back placed but its record could not be saved. No automatic retry.'); }
      return view('placed', 'Call back placed. The caller must still answer and give their authorization phrase.');
    },
  };
}
