/**
 * Který model katalogu kreslí hrdinu a nepřítele arkády – z popisku role.
 *
 * Čisté funkce mimo React (P26 T5): tabulka schopností `src/play/capabilities.ts`
 * tvrdí, které popisky vykreslení čte, a test to ověřuje právě tady.
 */

import type { GameSpecV1 } from '../spec';

/** Hrdinové, kteří v katalogu mají model; jiný popisek hráče kreslí `explorer`. */
export const HERO_MODELS: ReadonlySet<string> = new Set(['explorer', 'robot', 'fox', 'kid', 'raccoon', 'astronaut', 'knight', 'penguin', 'cat', 'hamster', 'goblin', 'slime', 'seal', 'ghost']);

/** Poletování bez známého hrdiny kreslí ptáčka (primitiv), závod auto nebo letadlo, ostatní `explorer`. */
export function heroModel(spec: GameSpecV1): string {
  const label = spec.roles.find((role) => role.kind === 'player')?.label.toLowerCase() ?? '';
  if (spec.control === 'steer') return /\b(?:plane|pilot|jet)\b/.test(label) ? 'plane' : 'race-car';
  const noun = label.split(/\s+/).at(-1) ?? '';
  return HERO_MODELS.has(noun) ? noun : spec.control === 'flap' ? 'bird' : 'explorer';
}

/** Nepřátelé střelnice: model z popisku role `enemy`, když ho katalog má, jinak robot. */
export function enemyModel(spec: GameSpecV1): string {
  const noun = spec.roles.find((role) => role.id === 'enemy')?.label.toLowerCase().split(/\s+/).at(-1) ?? '';
  return HERO_MODELS.has(noun) ? noun : 'robot';
}
