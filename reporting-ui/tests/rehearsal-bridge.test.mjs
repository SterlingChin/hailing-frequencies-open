import test from 'node:test';
import assert from 'node:assert/strict';
import { createRehearsalBridge, rehearsalConfig } from '../server/rehearsal-bridge.mjs';

test('real-data rehearsal keeps service credentials and session tokens server-side and forwards the four Decisions answers', async () => {
  const requests = [];
  const context = { profile: { display_name: 'Avery Chen' }, selected_case: null, queue: [] };
  const bridgeFactory = createRehearsalBridge({ config: { enabled: true, url: 'https://backend.example', token: 't'.repeat(40) },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body); requests.push({ url, body, authorization: init.headers.Authorization });
      const data = body.action === 'start' ? { ok: true, session_token: 'private-session', tools: [{ name: 'load_crew_profile' }, { name: 'get_crm_context' }], instructions: 'Backend instructions' }
        : body.name === 'load_crew_profile' ? { ok: true, crm_context: context }
          : url.endsWith('/api/decisions') ? { ok: true, outcome: 'queue', route: 'it', reused: false,
            answers: { route: { value: 'it', confidence: 0.9 }, resolvable_now: 0.1, needs_more_details: 0.1, urgency: { score: 0, label: 'routine' } }, crm_context: context }
            : { ok: true, state: 'ended' };
      return { status: 200, json: async () => data };
    } });
  const bridge = await bridgeFactory.start();
  assert.equal(bridge.context.profile.display_name, 'Avery Chen');
  assert.equal(bridge.tools.some(tool => tool.name === 'load_crew_profile'), false);
  assert.equal(bridge.tools.some(tool => tool.name === 'route_request'), true);
  const result = await bridge.call('route_request', { request: 'Report will not open' });
  assert.equal(result.answers.route.value, 'it');
  assert.equal(requests[2].url, 'https://backend.example/api/decisions');
  assert.equal(requests[2].body.session_token, 'private-session');
  assert.equal(requests[2].authorization, `Bearer ${'t'.repeat(40)}`);
  assert.doesNotMatch(JSON.stringify(bridge.public()), /private-session|Bearer|Authorization, Chen/);
  await bridge.end(); assert.equal(requests.at(-1).body.action, 'end');
});

test('rehearsal cannot be served from a public listener', () => {
  assert.throws(() => rehearsalConfig({ REHEARSAL_ENABLED: 'true', HOST: '0.0.0.0', HF_BACKEND_URL: 'https://example.org', REPORTING_API_TOKEN: 'x'.repeat(40) }), /local loopback/);
});
