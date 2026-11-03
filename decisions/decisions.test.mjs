import test from 'node:test';
import assert from 'node:assert/strict';
import { QUESTIONS, THRESHOLDS, buildDecisionRequest, interpretAnswers } from './questions.mjs';
import { createDecisionsClient } from './client.mjs';
import { buildContextBundle } from '../context/bundle.mjs';

const answers = ({ route = 'maintenance', confidence = 0.9, resolvable = 0.1, details = 0.1, urgency = 'elevated' } = {}) => [
  { type: 'choice', name: 'route', choice: route, confidence, probabilities: [{ value: route, probability: confidence }] },
  { type: 'predicate', name: 'resolvable_now', probability: resolvable },
  { type: 'predicate', name: 'needs_more_details', probability: details },
  { type: 'score', name: 'urgency', score: 1, confidence: 0.8, probabilities: [{ value: 1, label: urgency, probability: 0.7 }, { value: 0, label: 'routine', probability: 0.3 }] },
];
const ok = (body, status = 200) => async () => ({ status, headers: new Headers(), json: async () => body });

test('request matches the contract: model, string input, named questions, optional safety identifier', () => {
  const request = buildDecisionRequest({ input: 'Replicator coffee is cold.', safetyIdentifier: 'interaction-1' });
  assert.equal(request.model, 'gpt-6-luna'); assert.equal(request.questions.length, QUESTIONS.length);
  assert.deepEqual(Object.keys(request).sort(), ['input', 'model', 'questions', 'safety_identifier']);
  for (const q of request.questions) { assert.ok(['predicate', 'choice', 'score'].includes(q.type)); assert.ok(q.name && q.instructions); }
  assert.deepEqual(request.questions.find(q => q.name === 'route').choices.map(c => c.value), ['it', 'maintenance', 'none']);
  assert.ok(request.questions.find(q => q.name === 'urgency').levels.length <= 10);
  assert.equal('safety_identifier' in buildDecisionRequest({ input: 'x' }), false);
  assert.throws(() => buildDecisionRequest({ input: '  ' }), /decision_input_required/);
  assert.throws(() => buildDecisionRequest({ input: 'x', safetyIdentifier: 'a'.repeat(129) }), /invalid_safety_identifier/);
});

test('interpretation: confident route first, then details, stored solution, or undecided', () => {
  assert.equal(interpretAnswers(answers({ confidence: 0.5, details: THRESHOLDS.needsMoreDetails })).outcome, 'needs_more_details');
  assert.equal(interpretAnswers(answers({ route: 'none', resolvable: 0.9 })).outcome, 'solution');
  const queued = interpretAnswers(answers({ route: 'it', confidence: 0.8 }));
  assert.equal(queued.outcome, 'queue'); assert.equal(queued.route, 'it'); assert.equal(queued.urgencyLabel, 'elevated');
  for (const route of ['access', 'expert']) assert.equal(interpretAnswers(answers({ route, confidence: 0.99 })).outcome, 'undecided');
  const refused = interpretAnswers([{ type: 'refusal', name: 'route' }, ...answers().slice(1)]);
  assert.equal(refused.outcome, 'undecided'); assert.deepEqual(refused.refusals, ['route']);
  assert.equal(interpretAnswers(null).outcome, 'undecided');
  assert.equal(interpretAnswers(answers({ route: 'bogus' })).outcome, 'undecided');
});

test('follow-up scoring requires a strong blocker and preserves route and solution confidence gates', () => {
  // Policy examples, not measured model outputs from the caller transcript.
  for (const details of [0.5, 0.65, 0.749]) {
    for (const route of ['it', 'maintenance']) {
      assert.equal(interpretAnswers(answers({ route, details })).outcome, 'queue');
      assert.equal(interpretAnswers(answers({ route, details, confidence: 0.39 })).outcome, 'undecided');
    }
    assert.equal(interpretAnswers(answers({ route: 'none', resolvable: 0.6, details })).outcome, 'solution');
    assert.equal(interpretAnswers(answers({ route: 'none', resolvable: 0.59, details })).outcome, 'undecided');
  }
  for (const details of [0.75, 0.9, 1]) {
    assert.equal(interpretAnswers(answers({ confidence: 0.5, details })).outcome, 'needs_more_details');
  }
});

test('every expert route strictly above 0.50 wins over missing details; none is not an expert', () => {
  for (const route of ['it', 'maintenance']) {
    for (const confidence of [0.500001, 0.51, 0.96, 0.97, 1]) {
      for (const details of [0, 0.48, 0.8, 1]) {
        assert.equal(interpretAnswers(answers({ route, confidence, details })).outcome, 'queue');
      }
    }
    for (const confidence of [0, 0.4, 0.4999, 0.5]) {
      assert.equal(interpretAnswers(answers({ route, confidence, details: 1 })).outcome, 'needs_more_details');
      assert.equal(interpretAnswers(answers({ route, confidence, details: 0 })).outcome, 'undecided');
    }
  }
  assert.equal(interpretAnswers(answers({ route: 'none', confidence: 1, details: 1 })).outcome, 'needs_more_details');
});

test('client: disabled without a key, posts the contract body, validates the answer list, never retries', async () => {
  const disabled = createDecisionsClient({ apiKey: '' });
  assert.equal(disabled.enabled, false);
  assert.equal((await disabled.decide({ input: 'x' })).error.code, 'decisions_unavailable');

  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return ok({ model: 'gpt-6-luna', answers: answers(), usage: { input_tokens: 42, total_tokens: 42 } })(); };
  const client = createDecisionsClient({ apiKey: 'sk-fixture', fetch });
  const result = await client.decide({ input: 'Replicator coffee is cold.', safetyIdentifier: 'interaction-1' });
  assert.equal(result.ok, true); assert.equal(result.answers.length, QUESTIONS.length); assert.equal(result.usage.input_tokens, 42);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.openai.com/v1/decisions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-fixture');
  assert.equal(calls[0].init.redirect, 'error');
  const sent = JSON.parse(calls[0].init.body); assert.equal(sent.safety_identifier, 'interaction-1'); assert.equal(sent.questions.length, QUESTIONS.length);

  const http = createDecisionsClient({ apiKey: 'sk-fixture', fetch: ok({ error: { message: 'secret detail' } }, 429) });
  const failed = await http.decide({ input: 'x' });
  assert.equal(failed.error.code, 'decisions_http'); assert.equal(failed.error.status, 429); assert.equal(JSON.stringify(failed).includes('secret'), false);

  const short = createDecisionsClient({ apiKey: 'sk-fixture', fetch: ok({ model: 'gpt-6-luna', answers: answers().slice(1) }) });
  assert.equal((await short.decide({ input: 'x' })).error.code, 'decisions_invalid_body');

  let attempts = 0;
  const flaky = createDecisionsClient({ apiKey: 'sk-fixture', fetch: async () => { attempts += 1; throw new TypeError('fetch failed'); } });
  assert.equal((await flaky.decide({ input: 'x' })).error.code, 'decisions_network'); assert.equal(attempts, 1);

  const slow = createDecisionsClient({ apiKey: 'sk-fixture', timeoutMs: 5, fetch: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  assert.equal((await slow.decide({ input: 'x' })).error.code, 'decisions_timeout');
});

test('malformed named answers and refusal of any question cannot route work', async () => {
  const mutations = [
    a => { a[1].name = 'route'; },
    a => { a[3].name = 'unknown'; },
    a => { delete a[0].confidence; },
    a => { a[0].confidence = 2; },
    a => { a[1].probability = -0.1; },
    a => { a[2].probability = NaN; },
    a => { a[3].score = 4; },
    a => { a[3].probabilities[0].probability = 2; },
    a => { a[3].probabilities = []; },
  ];
  for (const mutate of mutations) {
    const input = answers(); mutate(input);
    assert.equal(interpretAnswers(input).outcome, 'undecided');
    const client = createDecisionsClient({ apiKey: 'sk-fixture', fetch: ok({ answers: input }) });
    assert.equal((await client.decide({ input: 'Fixture request' })).error.code, 'decisions_invalid_body');
  }
  for (let i = 0; i < QUESTIONS.length; i++) {
    const input = answers(); input[i] = { name: input[i].name, type: 'refusal' };
    const result = interpretAnswers(input);
    assert.equal(result.outcome, 'undecided'); assert.equal(result.reason, 'refused');
  }
});

test('deadline covers response body reading as well as headers', async () => {
  let attempts = 0;
  const client = createDecisionsClient({ apiKey: 'sk-fixture', timeoutMs: 5,
    fetch: async (_, { signal }) => {
      attempts++;
      return { status: 200, json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true })) };
    },
  });
  assert.equal((await client.decide({ input: 'Fixture request' })).error.code, 'decisions_timeout');
  assert.equal(attempts, 1);
});

test('context bundle carries profile, case and request within budget and withholds phone numbers', () => {
  const profile = { display_name: 'Avery Chen', rank: 'Ensign', ship: 'USS Fixture', language: 'en',
    equipment: [{ id: 'e1', model: 'RPL-2400', location: 'Deck 7 mess', last_service_note: 'Calibrated' }],
    preferences: [{ topic: 'repair', channel: 'sms' }],
    open_cases: [{ caseId: 'HF-001', brief: 'HF-001 (open); Symptom: coffee cold. Call +12025550123 back.' }] };
  const bundle = buildContextBundle({ profile, caseBrief: 'HF-001 (open); opened today.', request: 'I cannot open the science report; text me at +12025550123.' });
  assert.match(bundle.text, /Ensign Avery Chen, USS Fixture/); assert.match(bundle.text, /RPL-2400 at Deck 7 mess/); assert.match(bundle.text, /Selected case: HF-001/);
  assert.equal(/\+1202/.test(bundle.text), false); assert.match(bundle.text, /\[number withheld\]/);
  assert.equal(bundle.identified, true); assert.equal(bundle.hasSelectedCase, true);
  const anonymous = buildContextBundle({ request: 'x'.repeat(2000), channel: 'sms' });
  assert.match(anonymous.text, /not identified/); assert.ok(anonymous.text.length < 700);
  assert.throws(() => buildContextBundle({ request: '' }), /request_required/);
  assert.throws(() => buildContextBundle({ request: 'x', channel: 'fax' }), /invalid_channel/);
});
