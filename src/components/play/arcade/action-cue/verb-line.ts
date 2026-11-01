/**
 * Řádek se slovesem (P43 T7): „Shoot the goblins!“ na začátku hry, ať hráč
 * do tří vteřin ví, co hrdina dělá. Skládá se ze specu (`verbsOfSpec`), ne
 * z věty: řádek smí říct jen sloveso, které hra hraje. Copy podle kitu
 * (`docs/brand/docs/11-voice-copy.md`): rozkazovací, sentence case, ≤ 50 znaků.
 */

import { plural } from '@/play/draft/lexicon';
import type { GameRole, GameSpecV1 } from '@/play/spec';

import { type CueVerb, verbsOfSpec } from './cues';

export const VERB_LINE_MAX = 50;

/** Jak dlouho řádek visí: první tři vteřiny hry hráče (cíl P43 – „do 3 s“). */
export const VERB_LINE_SECONDS = 3;

/**
 * Řádek se ukáže až po prvním tahu (tik 0 patří výzvě „Tap to start“), jen v běhu hráče, ne v ukázce robota.
 * `until` (tik) ho ukončí dřív: v souboji první útok – od něj mluví povely nad soupeřem (P58C T6b).
 */
export function verbLineShown(tick: number, hz: number, playerRun: boolean, until = VERB_LINE_SECONDS * hz): boolean {
  return playerRun && tick > 0 && tick < Math.min(until, VERB_LINE_SECONDS * hz);
}

/** Jak sloveso zní hráči; chybějící sloveso (dojít, přežít, rytmus, „interact“) řádek nemá – to řekne cílová věta. */
const SAY: Partial<Record<CueVerb, (things: string) => string>> = {
  shoot: (things) => `Shoot the ${things}!`,
  throw: (things) => `Throw at the ${things}!`,
  collect: (things) => `Grab the ${things}!`,
  catch: (things) => `Catch the ${things}!`,
  deliver: (things) => `Bring it to the ${things}!`,
  defeat: (things) => `Beat the ${things}!`,
  fight: (things) => `Beat the ${things}!`,
  beat: (things) => `Beat the ${things}!`,
  duel: (things) => `Beat the ${things}!`,
  kick: (things) => `Kick it past the ${things}!`,
};
const SHORT: Partial<Record<CueVerb, string>> = { shoot: 'Shoot them!', throw: 'Throw!', collect: 'Grab them!', catch: 'Catch them!', deliver: 'Bring it!', kick: 'Kick it!' };

/** Druhy rolí, se kterými se sloveso dělá, když cíl specu žádnou roli nejmenuje. */
const OBJECT_KINDS: Partial<Record<CueVerb, readonly GameRole['kind'][]>> = {
  shoot: ['hazard', 'target', 'chaser'],
  throw: ['target', 'hazard'],
  collect: ['collectible'],
  catch: ['collectible'],
  deliver: ['target', 'exit'],
  defeat: ['hazard', 'target', 'chaser'],
  fight: ['hazard', 'chaser'],
  beat: ['hazard', 'chaser'],
  duel: ['hazard'],
  kick: ['hazard', 'target'],
};

const many = (label: string): string => (/[^s]s$/.test(label) ? label : plural(label, 2));

export function verbLine(spec: Pick<GameSpecV1, 'control' | 'addons' | 'objective' | 'heroAction' | 'roles'>): string | null {
  const verb = verbsOfSpec(spec).find((candidate) => SAY[candidate] !== undefined);
  if (verb === undefined) return null;
  const roles = spec.roles ?? [];
  const named = roles.find((role) => role.id === spec.objective.role && OBJECT_KINDS[verb]!.includes(role.kind));
  const thing = named ?? roles.find((role) => OBJECT_KINDS[verb]!.includes(role.kind));
  if (thing === undefined) return SHORT[verb] ?? null;
  // P68 T11: v obchodě (`buildshift`) se zákazníci obsluhují, ne sbírají (`stavba/integration.md` → HUD labels).
  const say = spec.control === 'buildshift' && verb === 'collect' ? (things: string) => `Serve the ${things}!` : SAY[verb]!;
  const line = say(many(thing.label.trim().toLowerCase()));
  return line.length <= VERB_LINE_MAX ? line : (SHORT[verb] ?? null);
}
