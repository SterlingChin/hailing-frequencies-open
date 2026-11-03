import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveChannel } from '../src/live-client.js';

function browserFixture(t, { microphone, earlyStart = false } = {}) {
  let tracksStopped = 0;
  const track = { enabled: true, stop: () => tracksStopped++ };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const previous = ['window', 'navigator', 'RTCPeerConnection'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { isSecureContext: true } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: microphone ?? (async () => stream) } } });
  class Peer {
    iceGatheringState = 'complete';
    addTrack() {}
    createDataChannel() { return this.channel = { close() {} }; }
    async createOffer() { return { type: 'offer', sdp: 'fixture-offer' }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription() {
      if (earlyStart) this.channel.onmessage({ data: JSON.stringify({ type: 'session.started' }) });
    }
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  t.after(() => { for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  return { stream, track, get tracksStopped() { return tracksStopped; } };
}
test('cancel while microphone permission is pending stops eventual tracks and creates no session', async t => {
  let resolveMicrophone, requests = 0;
  const f = browserFixture(t, { microphone: () => new Promise(resolve => { resolveMicrophone = resolve; }) });
  const channel = new LiveChannel({ audio: { pause() {} }, request: () => requests++, onEvent() {}, onError() {} });
  const pending = channel.connect(); channel.cleanup(); resolveMicrophone(f.stream); await pending;
  assert.equal(f.tracksStopped, 1); assert.equal(requests, 0);
});
test('a startup event during remote description prevents a false timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserFixture(t, { earlyStart: true });
  const requests = [], errors = [];
  const channel = new LiveChannel({ audio: { pause() {} },
    request: async (path, body) => { requests.push({ path, body }); return { sdp: 'fixture-answer' }; },
    onEvent: event => { if (event.type === 'session.started') channel.started(); }, onError: error => errors.push(error),
  });
  await channel.connect();
  t.after(() => channel.cleanup());
  t.mock.timers.tick(31000);
  assert.equal(errors.length, 0);
  assert.equal(requests[0].path, '/api/begin');
  assert.equal(requests[1].path, '/api/live/ready');
  assert.equal(channel.mute(), true);
  assert.equal(channel.stream.getAudioTracks()[0].enabled, false);
});
