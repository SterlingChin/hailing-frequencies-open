export function speakingPreference(profile) {
  const language = profile?.preferred_language === 'klingon' ? 'klingon' : 'english';
  return { language, voice: language === 'klingon' ? 'cedar' : 'marin', instructions: language === 'klingon'
    ? 'Speak Klingon in every spoken reply. Keep names, authorization phrases, tool names, IDs and stored records unchanged. Never translate or repair authorization credentials.'
    : 'Speak English in spoken replies. Keep names, tool names, IDs and stored records unchanged.' };
}
