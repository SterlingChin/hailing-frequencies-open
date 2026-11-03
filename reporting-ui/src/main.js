import './style.css';
import { LiveChannel } from './live-client.js';
import { createApiClient } from './api-client.js';

const $ = id => document.getElementById(id);
let voiceChanging = false;
let state, csrf, opening = false, stopping = false, generation = 0, channelId;
let editorRevision = 0, savingReport = false, displayedReportId;
let live, feed, reportDirty = false, lastReportVersion, lines = [], muted = false;
const text = (id, value) => { $(id).textContent = value; };
function notice(message) { text('notice', message || ''); $('notice').hidden = !message; }
function error(message) { text('error', message || ''); $('error').hidden = !message; }
const request = createApiClient({ getCsrf: () => csrf, setCsrf: value => { csrf = value; }, onRecovered: data => { update(data); error(''); } });
function setLine(role, content, append = false) {
  text('speaker', role === 'Agent' ? 'SUPPORT OFFICER / CAPTION' : 'COMMANDER CHEN / CAPTION');
  const previous = lines.at(-1);
  if (append && previous?.role === role) previous.content += content;
  else lines.push({ role, content });
  lines = lines.slice(-100);
  // Live fragments do not define complete turns. Group consecutive speaker fragments.
  const last = lines.at(-1); last.content = last.content.slice(-10000);
  text('channel-title', last.content);
  if (!append && role === 'Agent') text('announcement', last.content);
  $('transcript-details').hidden = false;
  text('transcript-count', String(lines.length));
  $('transcript').replaceChildren(...lines.map(line => {
    const item = document.createElement('li'); item.dataset.role = line.role;
    const label = document.createElement('strong'); label.textContent = line.role;
    const content = document.createElement('p'); content.textContent = line.content;
    item.append(label, content); return item;
  }));
}
function render() {
  if (!state) return;
  const responses = state.debugResponses || [];
  text('debug-count', String(responses.length));
  text('debug-note', `API response bodies for this conversation. Credentials and session tokens are redacted.${state.debugDropped ? ` ${state.debugDropped} older responses removed from the bounded history.` : ''}`);
  $('debug-responses').replaceChildren(...responses.map(entry => {
    const item = document.createElement('article');
    const summary = document.createElement('p');
    summary.textContent = `${entry.timestamp} · ${entry.method} ${entry.endpoint}${entry.operation ? ` · ${entry.operation}` : ''} · ${entry.status ?? 'Transport error'} · ${entry.durationMs} ms${entry.truncated ? ' · BODY TRUNCATED AT 1 MiB' : ''}`;
    const pre = document.createElement('pre'); pre.textContent = entry.body;
    item.append(summary, pre); return item;
  }));
  if (!responses.length) text('debug-responses', 'No API responses yet. Engage to start a conversation.');
  const engaged = opening || state.active;
  const closing = state.liveStatus === 'closing';
  $('engage').disabled = stopping || closing || savingReport || (!engaged && !state.liveConfigured);
  text('engage-label', engaged ? (opening ? 'Cancel' : 'End') : 'Engage');
  text('engage-hint', engaged ? 'CLOSE THE CHANNEL' : 'OPEN A CHANNEL');
  $('orbit').dataset.active = String(engaged);
  $('engage-icon').style.display = engaged ? 'none' : '';
  const status = stopping || closing ? 'Closing…' : opening ? 'Connecting…' : state.active ? muted ? 'Mic muted' : 'Channel open' : state.liveStatus === 'unconfirmed' ? 'Disconnected' : 'Standby';
  text('connection', status);
  $('connection').dataset.state = closing || opening ? 'working' : state.liveStatus === 'unconfirmed' ? 'unconfirmed' : state.active ? 'connected' : 'ready';
  text('mode-note', state.liveConfigured ? 'GPT-Live voice · tap Engage to connect' : 'GPT-Live is not configured on this server');
  $('microphone').hidden = !state.active || opening;
  text('microphone', muted ? 'Unmute microphone' : 'Mute microphone');
  if (!engaged && !state.liveConfigured) notice('Live voice is unavailable. The server needs its OpenAI configuration.');
  const step = state.active && !state.authorized ? 'identity' : state.hasCurrentReport ? 'review' : state.authorized ? 'report' : 'identity';
  for (const name of ['identity', 'report', 'review']) {
    if (step === name) $(`step-${name}`).setAttribute('aria-current', 'step');
    else $(`step-${name}`).removeAttribute('aria-current');
  }
  text('next-step', !engaged ? state.report ? 'Your recap is available below.' : 'Open a channel to report an issue.'
    : opening ? 'Preparing your channel…' : state.hasCurrentReport ? state.report?.delivery === 'recorded' ? 'Your report is recorded.' : 'Confirm the officer’s spoken readback.' : state.authorized ? 'Tell the officer what happened.' : 'Confirm the phrase from your profile.');
  $('report-section').hidden = !state.report;
  if (state.report) {
    text('recap-crew', [state.report.crew?.rank, state.report.crew?.display_name || state.report.crew?.name, state.report.crew?.ship].filter(Boolean).join(' · '));
    text('report-id', `${state.report.id} / ${state.report.mode.toUpperCase()} CHANNEL`);
    text('review-state', state.report.delivery === 'recorded' ? 'Report recorded by the context service' : state.report.delivery === 'rejected' ? 'Report rejected: ship not found' : state.report.delivery === 'unconfirmed' ? 'Submission outcome unconfirmed' : 'Awaiting spoken confirmation');
    text('report-delivery', state.report.delivery === 'recorded' ? 'Recorded' : state.report.delivery === 'rejected' ? 'Not recorded' : state.report.delivery === 'unconfirmed' ? 'Outcome unconfirmed' : 'Awaiting spoken confirmation');
    if (!reportDirty && (lastReportVersion !== state.report.updatedAt || displayedReportId !== state.report.id)) {
      $('report-issue').textContent = state.report.issue;
      $('report-location').textContent = state.report.location || 'Not specified';
      lastReportVersion = state.report.updatedAt;
      displayedReportId = state.report.id;
    }
  }
    $('download-report').disabled = savingReport;
  $('report-history').hidden = (state.reports?.length ?? 0) < 2;
  $('report-list').replaceChildren(...(state.reports || []).slice().reverse().map(report => {
    const item = document.createElement('li'), button = document.createElement('button');
    button.type = 'button'; button.textContent = `${report.id} · ${report.issue}`;
    button.disabled = savingReport || report.id === state.report?.id;
    button.addEventListener('click', async () => {
      try {
        update(await request('/api/report/select', { id: report.id }));
      } catch (err) { error(err.message); }
    });
    item.append(button); return item;
  }));
}
function update(data) {
  if (!state?.authorized && data.authorized) text('announcement', 'Profile loaded. Please describe your issue.');
  else if (data.hasCurrentReport && data.report?.id !== state?.report?.id) text('announcement', 'Issue captured. A recap is available for review below. It has not been sent.');
  state = { ...state, ...data }; render();
  if (state.voiceSwitchPending && state.active) void changeVoice();
}
async function endChannel({ preserveError = false } = {}) {
  if (stopping) return;
  const stoppedChannelId = channelId || state.channelId;
  const current = ++generation; stopping = true; opening = false;
  live?.cleanup(); live = null; muted = false;
  $('play-audio').hidden = true;
  state.active = false; render();
  if (!preserveError) { error(''); notice('Channel ended. Any captured report remains available for review.'); }
  try {
    const data = await request('/api/stop', { channelId: stoppedChannelId });
    if (current === generation) update(data);
  } catch (err) { if (current === generation) error(err.message); }
  finally { if (current === generation) { stopping = false; render(); } }
}
function createVoiceChannel(current, ownedChannelId, switching = false) {
  const channelRequest = (path, body) => request(switching && path === '/api/begin' ? '/api/live/voice' : path, { ...body, channelId: ownedChannelId });
  return new LiveChannel({ audio: $('agent-audio'), request: channelRequest,
        onAudioBlocked: () => { $('play-audio').hidden = false; notice('Tap Play agent audio to enable sound.'); },
        onError: err => { if (current === generation) { error(err.message); void endChannel({ preserveError: true }); } },
        onEvent: event => {
          if (current !== generation) return;
          if (event.type === 'session.started') { live?.started(); opening = false; state.active = true; render(); }
          else if (event.type === 'session.input_transcript.delta') setLine('You', event.delta || '', true);
          else if (event.type === 'session.output_transcript.delta') setLine('Agent', event.delta || '', true);
          else if (event.type === 'session.closed') { void endChannel(); }
          else if (event.type === 'error') { error('The voice service could not continue this channel. Check server configuration.'); void endChannel({ preserveError: true }); }
        },
      });
 }
async function changeVoice() {
  if (voiceChanging || stopping || opening || !state?.active || !state.voiceSwitchPending) return;
  voiceChanging = true; const current = ++generation;
  live?.cleanup(); opening = true; notice('Connecting your preferred language and voice…'); render();
  try {
    live = createVoiceChannel(current, channelId || state.channelId, true);
    await live.connect();
    if (current === generation) { muted = false; notice(''); }
  } catch (err) {
    if (current === generation) { error(err.message); await endChannel({ preserveError: true }); }
  } finally { voiceChanging = false; }
}
async function engage() {
  if (stopping) return;
  if (opening || state.active) { await endChannel(); return; }
  error(''); notice(''); opening = true; const current = ++generation;
  // Channel IDs correlate actions; they are not authentication credentials.
  const ownedChannelId = channelId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  lines = []; $('transcript').replaceChildren(); $('transcript-details').hidden = true;
  reportDirty = false; lastReportVersion = null; $('report-feedback').textContent = '';
  render();
  try {
      live = createVoiceChannel(current, ownedChannelId);
      await live.connect();
  } catch (err) {
    if (current !== generation) return;
    error(err.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in Safari settings and try again.' : err.message);
    await endChannel({ preserveError: true });
  }
}
$('engage').addEventListener('click', () => void engage());
$('microphone').addEventListener('click', () => { if (live) { muted = live.mute(); render(); } });
$('play-audio').addEventListener('click', () => { $('agent-audio').play().then(() => { $('play-audio').hidden = true; notice(''); }).catch(() => error('Audio could not play. Check your device audio settings.')); });
$('download-report').addEventListener('click', async () => {
  try {
    const report = state.report;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${report.id}.json`; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    text('report-feedback', 'Recap downloaded.');
  } catch (err) { error(err.message); }
});
window.addEventListener('pagehide', () => {
  generation++; live?.cleanup(); feed?.close();
  if (state?.active || opening) void fetch('/api/stop', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ channelId: channelId || state.channelId }) });
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

async function initialize() {
  try {
    const existing = await request('/api/session'); csrf = existing.csrf;
    const fresh = await request('/api/reset', {}); csrf = fresh.csrf; state = fresh; channelId = fresh.channelId;
    render();
    feed = new EventSource('/api/events');
    feed.onmessage = event => {
      try {
        const next = JSON.parse(event.data); update(next);
        if (!next.active && ['closing', 'ended', 'unconfirmed', 'failed'].includes(next.liveStatus)) {
          opening = false; live?.cleanup(); live = null; render();
          if (next.liveStatus === 'unconfirmed') notice('The voice connection is closed, but the service did not confirm session finalization. No automatic reconnect was made.');
        }
      } catch { error('The channel update could not be read. Reload this page.'); }
    };
    feed.onerror = () => {
      if (state.active) { error('Server connection lost. Closing the microphone; your last captured report is shown below.'); void endChannel({ preserveError: true }); }
    };
  } catch (err) { error(err.message); }
}
void initialize();
