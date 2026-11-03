import test from 'node:test';
import assert from 'node:assert/strict';
import { speakingPreference } from '../server/language.mjs';
test('PR11 preferred_language alone selects Klingon voice, otherwise marin stays default', () => {
  assert.equal(speakingPreference({ preferred_language: 'klingon' }).voice, 'cedar');
  for (const profile of [null, {}, { language: 'Klingon' }, { preferred_language: 'english' }, { preferred_language: 'untrusted value' }]) assert.equal(speakingPreference(profile).voice, 'marin');
  assert.match(speakingPreference({ preferred_language: 'klingon' }).instructions, /Speak Klingon/);
});
