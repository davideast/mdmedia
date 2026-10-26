/**
 * What each Gemini voice sounds like, from a person listening, not a model:
 * a blind audio judge flipped on 13 of 30 voices across three neutral takes,
 * and called Algenib, a man's voice, a woman twice (plan 009). Casting only
 * auditions voices whose gender here matches the character's brief. Empty
 * until the voices are marked; a voice not listed is never cast for a brief
 * that names a gender.
 */
export const VOICE_FACTS: Readonly<Record<string, { gender: 'man' | 'woman' }>> = {};

/**
 * The gender a brief asks for, from its own words ("a woman", "girl", "she"),
 * or undefined when it says nothing either way or both.
 */
export function briefGender(brief: string): 'man' | 'woman' | undefined {
  const count = (re: RegExp) => (brief.match(re) ?? []).length;
  const woman = count(/\b(woman|women|girl|girls|she|her|hers|herself|grandmother|grandma|mother|aunt|lady|female)\b/gi);
  const man = count(/\b(man|men|boy|boys|he|him|his|himself|grandfather|grandpa|father|uncle|gentleman|male)\b/gi);
  if (woman > man * 2) return 'woman';
  if (man > woman * 2) return 'man';
  return undefined;
}
