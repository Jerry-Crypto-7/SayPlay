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
import type { GameSpecV1 } from '../spec';

export type UnsupportedKind = 'sandbox' | 'manipulate' | 'idle' | 'build_place';

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
    cues: [/\bopen[- ]world\b/, /\bmultiplayer\b/, /\bminecraft\b/, /\bcraft\b/, /\bgta\b/, /\bmmo\b/],
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
      /\bsort\b/,
      /\buntangle\b/,
      /\bpipes?\b/,
      /\bpull the pins?\b/,
      /\bunscrew\b/,
      /\bmirrors?\b/,
      /\bpark the cars?\b/,
      /\bword game\b/,
    ],
  },
  {
    kind: 'idle',
    reason: 'Games that grow while you tap or wait are not something we can build yet.',
    cues: [/\bidle\b/, /\bclicker\b/, /\bmerge\b/, /\bempire\b/, /\bhire\b/, /\bmakes? money\b/, /\bmanage\b/],
  },
  {
    kind: 'build_place',
    reason: 'Placing defenders or dressing things up is not something we can build yet.',
    cues: [
      /\btower defen[cs]e\b/,
      /\bdefend the\b/,
      /\bprotect the\b/,
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

/** Věta a hotový návrh → hláška, nebo `null`, když hra splní, co věta chtěla. */
export function unsupportedGame(sentence: string, draft: Pick<GameSpecV1, 'archetype' | 'control'>): Honesty | null {
  const text = sentence.toLowerCase();
  const match = CLASSES.find((entry) => entry.cues.some((cue) => cue.test(text)));
  if (match === undefined) return null;
  return {
    kind: match.kind,
    reason: match.reason,
    closest: draft.control === 'runner' ? 'an endless runner' : CLOSEST[draft.archetype],
  };
}
