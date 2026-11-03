import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { attachBridge } from './bridge.mjs';

const sessionConfig = {
  model: 'gpt-live-1',
  audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } },
  delegation: { type: 'responses', responses: { model: 'gpt-5.4-mini' } },
  store: false,
};
const streamSid = 'MZteststream';
const audio = (bytes = 160) => Buffer.alloc(bytes, 255).toString('base64');

class Socket extends EventEmitter {
  readyState = 0;
  sent = [];
  bufferedAmount = 0;
  closeCalls = 0;
  terminateCalls = 0;
  constructor(asyncClose = false) { super(); this.asyncClose = asyncClose; }
  open() { this.readyState = 1; this.emit('open'); }
  receive(value) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  send(value) {
    assert.equal(this.readyState, 1);
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.closeCalls += 1;
    if (this.readyState >= 2) return;
    const closed = () => { this.readyState = 3; this.emit('close'); };
    if (this.asyncClose) { this.readyState = 2; setImmediate(closed); }
    else closed();
  }
  terminate() { this.terminateCalls += 1; this.close(); }
}

function setup(t, options = {}) {
  const { asyncClose = false, ...bridgeOptions } = options;
  const twilio = new Socket(asyncClose);
  const model = new Socket(asyncClose);
  const events = [];
  const calls = [];
  let connections = 0;
  twilio.open();
  const bridge = attachBridge(twilio, {
    createModelSocket: () => { connections += 1; return model; },
    sessionConfig,
    lookupRepair: (args) => { calls.push(args); return { ok: true, procedure: 'fictional repair' }; },
    welcome: 'Hailing frequencies open.',
    maxSessionMs: 5000,
    startupTimeoutMs: 1000,
    closeTimeoutMs: 20,
    onEvent: (event) => events.push(event),
    ...bridgeOptions,
  });
  const start = (overrides = {}) => twilio.receive({
    event: 'start', streamSid,
    start: { streamSid, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }, ...overrides },
  });
  const ready = () => { start(); model.open(); model.receive({ type: 'session.started' }); };
  const input = (payload = audio()) => twilio.receive({ event: 'media', streamSid, media: { track: 'inbound', payload } });
  const tool = (overrides = {}) => model.receive({
    type: 'response.event', event: {
      type: 'response.output_item.done',
      item: { type: 'function_call', status: 'completed', name: 'lookup_repair', call_id: 'call-test', arguments: '{"model":"R-1","symptom":"cold coffee"}', ...overrides },
    },
  });
  const close = (seconds = 1.25) => {
    bridge.stop();
    model.receive({ type: 'session.closed', reason: 'close_requested', usage: { seconds } });
    return bridge.done;
  };
  t.after(async () => { bridge.stop(); await bridge.done; });
  return { twilio, model, events, calls, bridge, start, ready, input, tool, close, connections: () => connections };
}

test('starts only after Twilio metadata, gates early audio, and forwards raw audio in order', async (t) => {
  const h = setup(t);
  assert.equal(h.connections(), 0);
  h.start();
  h.input();
  assert.equal(h.connections(), 1);
  assert.deepEqual(h.model.sent, []);
  h.model.open();
  assert.deepEqual(h.model.sent, [{ type: 'session.start', session: sessionConfig }]);
  h.input(audio(320));
  assert.equal(h.model.sent.length, 1);
  h.model.receive({ type: 'session.started' });
  assert.deepEqual(h.model.sent.map((event) => event.type), [
    'session.start', 'session.instructions.append', 'session.commentary.append',
    'session.input_audio.append', 'session.input_audio.append',
  ]);
  assert.equal(h.model.sent[1].delegation_id, null);
  h.model.receive({ type: 'session.output_audio.delta', delta: audio(480) });
  assert.deepEqual(h.twilio.sent, [{ event: 'media', streamSid, media: { payload: audio(480) } }]);
  const result = await h.close();
  assert.equal(result.audioInputFrames, 2);
  assert.equal(result.audioInputBytes, 480);
  assert.equal(result.audioOutputFrames, 1);
  assert.equal(result.audioOutputBytes, 480);
});

test('keeps only the newest one second of startup audio', async (t) => {
  const h = setup(t);
  h.start();
  h.model.open();
  for (let index = 0; index < 60; index += 1) h.input();
  h.model.receive({ type: 'session.started' });
  const result = await h.close();
  assert.equal(result.audioInputBytes, 8000);
  assert.equal(result.audioInputFrames, 50);
  assert.equal(result.startupDroppedBytes, 1600);
  assert.equal(result.startupDroppedFrames, 10);
});

test('returns tool result before response continuation and deduplicates completed call IDs', async (t) => {
  const h = setup(t);
  h.ready();
  h.tool();
  h.tool();
  await tick();
  h.tool();
  await tick();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], { model: 'R-1', symptom: 'cold coffee' });
  const resultEvents = h.model.sent.filter((event) => event.type.startsWith('response.'));
  assert.deepEqual(resultEvents.map((event) => event.type), ['response.item.create', 'response.create']);
  assert.equal(resultEvents[0].item.call_id, 'call-test');
  assert.equal(JSON.parse(resultEvents[0].item.output).ok, true);
  const result = await h.close();
  assert.equal(result.toolRequests, 1);
  assert.equal(result.toolSuccesses, 1);
  assert.equal(result.toolFailures, 0);
});

test('slow tools allow audio to flow and late results are discarded after stop', async (t) => {
  let resolveLookup;
  const h = setup(t, { lookupRepair: () => new Promise((resolve) => { resolveLookup = resolve; }) });
  h.ready();
  h.tool();
  h.input();
  h.model.receive({ type: 'session.output_audio.delta', delta: audio() });
  assert.equal(h.twilio.sent.length, 1);
  assert.equal(h.model.sent.at(-1).type, 'session.input_audio.append');
  h.bridge.stop();
  resolveLookup({ ok: true, procedure: 'late result' });
  await tick();
  assert.equal(h.model.sent.some((event) => event.type === 'response.item.create'), false);
  const result = await h.close();
  assert.equal(result.toolRequests, 1);
  assert.equal(result.toolSuccesses, 0);
});

test('tool failures and invalid arguments produce honest structured results', async (t) => {
  const h = setup(t, { lookupRepair: () => { throw new Error('private failure text'); } });
  h.ready();
  h.tool();
  h.tool({ call_id: 'invalid-json', arguments: 'not-json' });
  h.tool({ call_id: 'invalid-array', arguments: '[]' });
  h.tool({ call_id: 'unsupported', name: 'send_sms' });
  await tick();
  const outputs = h.model.sent.filter((event) => event.type === 'response.item.create').map((event) => JSON.parse(event.item.output));
  assert.equal(outputs.length, 4);
  assert.deepEqual(outputs.map((value) => value.error.code), ['repair_lookup_failed', 'invalid_arguments', 'invalid_arguments', 'unsupported_tool']);
  assert.equal(outputs.every((value) => value.ok === false), true);
  assert.equal(JSON.stringify(h.events).includes('private failure'), false);
  const result = await h.close();
  assert.equal(result.toolFailures, 4);
  assert.equal(result.toolSuccesses, 0);
});

test('session.close waits for session.closed; cumulative usage is never summed', async (t) => {
  const h = setup(t);
  h.ready();
  h.model.receive({ type: 'session.usage.updated', usage: { seconds: 2 } });
  h.model.receive({ type: 'session.usage.updated', usage: { seconds: 3 } });
  h.twilio.receive({ event: 'stop', streamSid });
  assert.equal(h.model.sent.at(-1).type, 'session.close');
  assert.equal(h.model.closeCalls, 0);
  h.model.receive({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 3.5 } });
  const result = await h.bridge.done;
  assert.equal(result.finalized, true);
  assert.equal(result.usageSeconds, 3.5);
  assert.equal(result.finalUsageSeconds, 3.5);
  assert.equal(result.closeReason, 'twilio_stop');
  assert.equal(result.modelCloseReason, 'close_requested');
  assert.equal(result.modelTransportClosed, true);
});

test('a transport close without session.closed does not claim finalization', async (t) => {
  const h = setup(t);
  h.ready();
  h.model.receive({ type: 'session.usage.updated', usage: { seconds: 2 } });
  h.model.close();
  const result = await h.bridge.done;
  assert.equal(result.finalized, false);
  assert.equal(result.finalUsageSeconds, null);
  assert.equal(result.usageSeconds, 2);
  assert.equal(result.closeReason, 'model_disconnect');
  assert.equal(h.twilio.readyState, 3);
});

test('done waits for asynchronous socket close observations after finalization', async (t) => {
  const h = setup(t, { asyncClose: true });
  h.ready();
  let resolved = false;
  const done = h.close();
  done.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  const result = await done;
  assert.equal(result.finalized, true);
  assert.equal(result.twilioTransportClosed, true);
  assert.equal(result.modelTransportClosed, true);
});

test('failed or incomplete delegated responses stop safely without logging backend details', async (t) => {
  for (const type of ['error', 'response.failed', 'response.incomplete']) {
    await t.test(type, async (t) => {
      const h = setup(t);
      h.ready();
      h.model.receive({ type: 'response.event', event: { type, error: { message: 'private backend details' } } });
      assert.equal(h.model.sent.at(-1).type, 'session.close');
      h.model.receive({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 1 } });
      const result = await h.bridge.done;
      assert.equal(result.closeReason, 'backend_failed');
      assert.equal(result.backendFailureReason, type);
      assert.equal(result.finalized, true);
      assert.equal(JSON.stringify(h.events).includes('private backend'), false);
    });
  }
});

test('missing finalization confirmation is bounded and closes both sockets', async (t) => {
  const h = setup(t, { closeTimeoutMs: 10 });
  h.ready();
  const result = await h.bridge.stop();
  assert.equal(result.finalized, false);
  assert.equal(result.finalUsageSeconds, null);
  assert.equal(h.model.readyState, 3);
  assert.equal(h.twilio.readyState, 3);
  assert.equal(h.model.sent.filter((event) => event.type === 'session.close').length, 1);
});

test('maximum duration closes a ready session and records its reason', async (t) => {
  const h = setup(t, { maxSessionMs: 10, closeTimeoutMs: 5 });
  h.ready();
  const result = await h.bridge.done;
  assert.equal(result.closeReason, 'max_duration');
  assert.equal(h.model.sent.at(-1).type, 'session.close');
  assert.equal(result.finalized, false);
});

test('startup timeout closes an unready connection', async (t) => {
  const h = setup(t, { startupTimeoutMs: 10 });
  h.start();
  const result = await h.bridge.done;
  assert.equal(result.closeReason, 'startup_timeout');
  assert.equal(result.started, false);
  assert.equal(h.model.readyState, 3);
});

test('malformed start never creates a model session', async (t) => {
  const h = setup(t);
  h.start({ mediaFormat: { encoding: 'audio/pcm', sampleRate: 24000, channels: 1 } });
  const result = await h.bridge.done;
  assert.equal(result.closeReason, 'invalid_twilio_start');
  assert.equal(h.connections(), 0);
});

test('duplicate start cannot create another model session', async (t) => {
  const h = setup(t);
  h.ready();
  h.start();
  const result = await h.bridge.done;
  assert.equal(result.closeReason, 'invalid_twilio_start');
  assert.equal(h.connections(), 1);
});

test('media for a different stream terminates the bridge', async (t) => {
  const h = setup(t);
  h.ready();
  h.twilio.receive({ event: 'media', streamSid: 'MZother', media: { payload: audio() } });
  const result = await h.bridge.done;
  assert.equal(result.closeReason, 'invalid_stream');
  assert.equal(result.audioInputFrames, 0);
});

test('malformed JSON and noncanonical base64 are rejected', async (t) => {
  await t.test('JSON', async (t) => {
    const h = setup(t);
    h.twilio.emit('message', Buffer.from('{invalid'));
    assert.equal((await h.bridge.done).closeReason, 'invalid_twilio_message');
    assert.equal(h.connections(), 0);
  });
  await t.test('base64', async (t) => {
    const h = setup(t);
    h.ready();
    h.input('ab=='); // Decodes leniently in Node, but is not canonical base64.
    assert.equal((await h.bridge.done).closeReason, 'invalid_twilio_audio');
  });
});

test('output before session readiness and socket backpressure terminate safely', async (t) => {
  await t.test('early output', async (t) => {
    const h = setup(t);
    h.start();
    h.model.open();
    h.model.receive({ type: 'session.output_audio.delta', delta: audio() });
    assert.equal((await h.bridge.done).closeReason, 'invalid_model_sequence');
    assert.equal(h.twilio.sent.length, 0);
  });
  await t.test('backpressure', async (t) => {
    const h = setup(t);
    h.ready();
    h.twilio.bufferedAmount = 300 * 1024;
    h.model.receive({ type: 'session.output_audio.delta', delta: audio() });
    assert.equal((await h.bridge.done).closeReason, 'twilio_send_failed');
    assert.equal(h.twilio.sent.length, 0);
  });
});

test('diagnostics only contain known status fields and numeric counters', async (t) => {
  const h = setup(t);
  h.ready();
  h.input();
  h.tool();
  await tick();
  await h.close();
  const text = JSON.stringify(h.events);
  for (const privateValue of [streamSid, 'call-test', 'cold coffee', 'fictional repair', audio(), 'Hailing frequencies open']) {
    assert.equal(text.includes(privateValue), false);
  }
  assert.ok(h.events.some((event) => event.type === 'finished'));
});
