/**
 * Poctivá hláška (P25E T1): věta chce hru, na kterou knihovna ovládání nemá.
 *
 * Návrh ze slov vždy nějakou hru postaví – u „match 3" nebo „tower defense"
 * je to ale tichá náhrada. Tenhle modul ji pojmenuje: z věty pozná jednu ze
 * čtyř tříd, které v tomhle kole neumíme (`manipulate`, `build_place`, `idle`,
 * `sandbox`), a řekne proč a co dostane hráč místo toho. Počítá se nad hotovým
 * návrhem, `draft.ts` o hlášce neví.
 *
 * Pořadí tříd je záměr: „multiplayer město, kde si postavím dům" je sandbox,
 * ne stavění, a „tetris s nábytkem" je skládání, ne zařizování.
 */

import type { ArchetypeId } from '../registry';
import type { ControlId, GameSpecV1 } from '../spec';
import type { PublishedGame, VersionStore } from '../version';
import { noVerbTopic } from './draft';

/** `no_verb` (P28D T4): věta hru nechce vůbec („explain quantum physics“) – hraje se běžec o jejím tématu. */
export type UnsupportedKind = 'sandbox' | 'manipulate' | 'idle' | 'build_place' | 'no_verb';

export interface Honesty {
  readonly kind: UnsupportedKind;
  /** Jedna věta pro hráče, proč tahle hra hratelná není. */
  readonly reason: string;
  /** Hra, kterou návrh postavil místo toho, se členem („a chase game"). */
  readonly closest: string;
}

const CLASSES: readonly { readonly kind: UnsupportedKind; readonly reason: string; readonly cues: readonly RegExp[] }[] = [
  {
    kind: 'sandbox',
    reason: 'Open worlds, crafting and multiplayer are bigger than one short game.',
    cues: [/\bopen[- ]world\b/, /\bmultiplayer\b/, /\bminecraft\b/, /\bcrafting\b/, /\bgta\b/, /\bmmo\b/],
  },
  {
    kind: 'manipulate',
    reason: 'Swapping, sorting and sliding pieces around is not something we can build yet.',
    cues: [
      /\bmatch[- ]?(?:3|three)\b/,
      /\bmatching game\b/,
      /\bcandy crush\b/,
      /\btetris\b/,
      /\bmahjong\b/,
      /\bjenga\b/,
      /\bslide (?:the )?blocks\b/,
      /\bsort\b.*\binto\b/,
      /\buntangle\b/,
      /\bconnect (?:the )?pipes\b/,
      /\bpull the pins?\b/,
      /\bunscrew\b/,
      /\bbeams? with mirrors?\b/,
      /\bpark the cars?\b/,
      /\bword game\b/,
    ],
  },
  {
    kind: 'idle',
    reason: 'Games that grow while you tap or wait are not something we can build yet.',
    cues: [
      /\bidle\b/,
      /\bclicker\b/,
      /\bmerge\b/,
      /\bhire\b.*\bupgrade\b/,
      /\bmakes? money\b/,
      /\bmanage (?:a|an|my) (?:\w+ )?(?:hotel|restaurant|shop|store|farm|zoo|park|business|company|factory)\b/,
    ],
  },
  {
    kind: 'build_place',
    reason: 'Placing defenders or dressing things up is not something we can build yet.',
    cues: [
      /\btower defen[cs]e\b/,
      /\bdefend the \w+ from\b/,
      /\bprotect the \w+ from\b/,
      /\bplants vs\b/,
      /\bplace \w+ to stop\b/,
      /\bdecorate\b/,
      /\bdress up\b/,
      /\boutfits?\b/,
      /\bmakeover\b/,
      /\bdesign my own\b/,
      /\bsalon\b/,
    ],
  },
];

const CLOSEST: Readonly<Record<ArchetypeId, string>> = {
  collect_exit: 'a collect-and-escape game',
  chase_escape: 'a chase game',
  survival_timer: 'a survival game',
  checkpoint_race: 'a race through checkpoints',
  delivery: 'a delivery game',
  switch_puzzle: 'a switch puzzle',
  hazard_crossing: 'a crossing game',
  combat_lite: 'a fight game',
};

/** Arkádové hry sdílejí archetyp šablony, takže je pojmenuje ovládání. */
const ARCADE_CLOSEST: Readonly<Record<Exclude<ControlId, 'tap_go'>, string>> = {
  runner: 'an endless runner',
  platform: 'a platformer',
  flap: 'a flappy game',
  steer: 'a racing game',
  move_free: 'an arena game',
  shooter: 'a shooting game',
  throw: 'a throwing game',
  timing: 'a timing game',
  rhythm: 'a rhythm game',
  duel: 'a duel',
};

/** Věta a hotový návrh → hláška, nebo `null`, když hra splní, co věta chtěla. */
export function unsupportedGame(sentence: string, draft: Pick<GameSpecV1, 'archetype' | 'control'>): Honesty | null {
  const text = sentence.toLowerCase();
  const match = CLASSES.find((entry) => entry.cues.some((cue) => cue.test(text)));
  if (match === undefined) {
    // Jen dokud hra je ten běžec – AI verze s jiným ovládáním hlášku nepotřebuje.
    const topic = draft.control === 'runner' ? noVerbTopic(sentence) : null;
    if (topic === null) return null;
    return { kind: 'no_verb', reason: `No game verb found – here is a runner about ${topic}. Try: ‘Dodge …’, ‘Collect …’`, closest: ARCADE_CLOSEST.runner };
  }
  return {
    kind: match.kind,
    reason: match.reason,
    // Arkádová hra si nese jméno podle ovládání – archetyp šablony je u všech
    // `hazard_crossing`, takže by hláška u plošinovky slibovala přecházení.
    closest: draft.control === undefined || draft.control === 'tap_go' ? CLOSEST[draft.archetype] : ARCADE_CLOSEST[draft.control],
  };
}

/**
 * Hláška pro publikovanou hru. Věta: návrh ji nese v `origin`, hra od režiséra
 * bez návrhu v `sentence`, autorská verze po upgradu ji má u rodiče.
 */
export async function honestyOf(versions: Pick<VersionStore, 'get'>, game: PublishedGame): Promise<Honesty | null> {
  const sentence = await sentenceOf(versions, game);
  return sentence === null ? null : unsupportedGame(sentence, game.spec);
}

export async function sentenceOf(versions: Pick<VersionStore, 'get'>, game: PublishedGame): Promise<string | null> {
  if (game.origin !== undefined) return game.origin.sentence;
  if (game.sentence !== undefined) return game.sentence;
  if (game.relation !== 'upgrade' || game.version.parentId === null) return null;
  return (await versions.get(game.version.parentId))?.origin?.sentence ?? null;
}
