/**
 * Žánr Šipky (P66 T9): mřížka kusů z věty (auta na parkovišti, ovce v ohradě), každý se šipkou směru. Klepnutý kus
 * odletí, když má ve směru šipky volnou cestu ven, jinak narazí a hráč ztratí srdce (ovládání `arrows`, vstup pruhů
 * s buňkou v ose – `cellAxisAt`, generátor `arrows_grid` v `arcade/pieces/arrows.ts`).
 *
 * Hloubka: `rounds` kol (2–5, výchozí 3) s rostoucí mřížkou, poslední je finále; úroveň je řešitelná konstrukcí
 * (`arrows-level.ts`); 3 srdce, hodiny celé hry `arrowsSeconds`; kombo za sérii odletů bez nárazu.
 *
 * Kusem je první věc obsazení (kulisa, překážka, sbíraná věc…), výchozí auto. Věty sem od P66 T12 vede znak žánru
 * v `classify.ts` (ťuk, po kterém kus odjede; kus jede, kam ukazuje; zácpa); e2e hraje z ručního specu
 * (`e2e/fixtures/p66-arrows-spec.json`).
 */

import { ARROWS, arrowsSeconds, totalPieces } from '../arcade/pieces/arrows-level';
import { nounPhrase, plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí kus, když ho věta nejmenuje (`GENRE_FOE.arrows`). */
export const ARROWS_DEFAULTS = { piece: 'car' } as const;

/** Předmět slovesa, které kusy posílá pryč („tap the cars“, „free the sheep“, „unpark the cars“, „clear the boats“). */
const ARROWS_OBJECT = /\b(?:tap|free|unpark|clear|release|unjam|unblock|send|steer|move|drive|park|herd|let)(?:s|es|ed|ing)?\s+(?:all\s+|the\s+|every\s+|each\s+|those\s+|some\s+|out\s+)*([a-z][a-z -]*)/;
/** Kusy jako podmět („cars escape the jammed lot“, „sheep leave the pen“). */
const LEAVING = /\b([a-z]+) (?:escape|leave|drive out|fly off|get out|exit|slide out)(?:s|es|ed|ing)?\b/;
/** „tap away“, „let them out“ nejsou věc v mřížce. */
const NOT_PIECE = /^(?:it|them|away|out|off|up|down|in|on|to|and|each|every|one)\b/;
/** Kde předmět končí: „the boats out of the harbor“ → „boats“. */
const PIECE_END = /\s+(?:out|off|away|free|up|down|back|along|so|that|from|of|in|into|to|onto|before|while|and|with|one)\b.*$/;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

/** Kus z věty: první věc obsazení, ať dělá cokoli – v mřížce je každá věc jen kus hádanky. */
const pieceOf = (spec: Parameters<typeof castFor>[0]): string =>
  castFor(spec, 'scenery', 'avoid', 'collect', 'reach', 'shoot_at', 'chase_me', 'fight', 'throw_at')?.label ?? ARROWS_DEFAULTS.piece;

export const arrowsGenre: GenreModule<'arrows'> = {
  id: 'arrows',
  modes: ['default'],
  // P66 T12: věty sem vede znak žánru v `classify.ts` (ťuk, po kterém kus odjede; kus jede, kam ukazuje; zácpa);
  // narážky přidají bod a v pořadí dají šipky před ostatní.
  cues: ['jammed', 'traffic jam', 'gridlock'],
  heroClasses: ['vehicle', 'animal', 'prop', 'humanoid', 'robot', 'monster'],
  paramBounds: {
    rounds: { min: ARROWS.rounds.min, max: ARROWS.rounds.max },
  },
  // P66 T12: živý – buňka `arrows.default` je v `PRESETS` a věty sem vede klasifikátor.
  availability: () => 'ready',
  compile: (spec) => {
    const rounds = spec.params?.rounds ?? ARROWS.rounds.default;
    const piece = singular(pieceOf(spec));
    const many = plural(piece, 2);
    const total = totalPieces(rounds);
    return legacySpec(spec, {
      control: 'arrows',
      controlParams: { generator: 'arrows_grid', tuning: { rounds } },
      archetype: 'combat_lite',
      title: fit(60, `${titleCase(piece)} Jam`, 'Arrow Jam'),
      objective: {
        kind: 'defeat_targets',
        description: fit(120, `Tap ${many} to send them off along their arrows. One with something in its way bumps and costs a heart.`, `Tap ${many} with a clear way out. A bump costs a heart.`, 'Tap the pieces with a clear way out. A bump costs a heart.'),
        count: total,
        role: 'piece',
      },
      mechanics: [livesMechanic()],
      roles: [{ id: 'piece', kind: 'target', label: piece, count: total }],
      tutorial: {
        goalLine: fit(50, `Clear every ${piece} in ${String(rounds)} rounds!`, `Clear them all in ${String(rounds)} rounds!`),
        controlsHint: 'Tap one with a clear way out. Arrows and Space work too.',
      },
      mood: 'playful',
      targetDurationSec: arrowsSeconds(rounds),
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Šipky znají jen jednu roli: kus v mřížce. Co věta posílá pryč, jde dopředu.
    let roles: CastItem[] = (cast ?? []).map((item) => ({ ...item, does: 'scenery' }));
    const text = sentence.toLowerCase();
    const found = ARROWS_OBJECT.exec(text);
    const object = found === null ? null : nounPhrase((found[1] as string).replace(PIECE_END, ''));
    const phrase = object !== null && !NOT_PIECE.test(object) ? object : (LEAVING.exec(text)?.[1] ?? null);
    if (phrase !== null && !NOT_PIECE.test(phrase)) {
      const label = singular(phrase);
      roles = [{ label, does: 'scenery' }, ...roles.filter((item) => item.label !== label)];
    }
    return {
      genre: 'arrows',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
