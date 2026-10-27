/**
 * Kolik z věty hra ukáže (P63 T3): role čtení – hrdina, hlavní hrozba a cíl, místo – proti rolím specifikace, ne podle
 * snímku. Hra po čtení nahradí rychlou hru jen tehdy, když jich ukáže aspoň tolik (`namesNoLess`): rytíř s drakem (h18)
 * se starým čtením hrál jízdu bez draka a řetěz ji publikoval. Rozhoduje server (`src/app/api/play/_upgrade.ts`) a týmž
 * počítá diagnóza P63 (`evals/play/p63/diagnose.mjs`).
 */

import { lookOf } from '../arcade/look';
import { singular } from '../draft/lexicon';
import type { GameRole, GameSpecV1 } from '../spec';
import type { Reading } from './schema';

/** Role, které hráč vidí jako nepřítele nebo věc z věty (P61 T2): nástraha, honič, hlídka a terč; sbíraná věc, předmět a klíč. */
export const SHOWN_KINDS: ReadonlySet<GameRole['kind']> = new Set(['hazard', 'chaser', 'patrol', 'target', 'collectible', 'item', 'key']);

/** Slova popisku v jednotném čísle („gold coins“ → gold, coin). */
const wordsOf = (label: string): string[] => label.toLowerCase().split(/\s+/).map(singular);

/** Hlava jména ze čtení: poslední slovo v jednotném čísle („fuel cells“ → cell, „giant Roomba“ → roomba). */
const headOf = (noun: string): string => wordsOf(noun).at(-1)!;

/**
 * Kolik rolí čtení hry `specs` ukážou (řetěz = všechna kola): hrdina (`hero`) v roli `player`; hlavní hrozba (`foe`)
 * a cíl (`item`), bez obou první role čtení, v roli nepřítele nebo věci (`SHOWN_KINDS` – drak jako kulisa nepřítel
 * není); místo (`world`) jako sada světa (`lookOf`). Jméno sedí, když hlava jména ze čtení je slovem popisku.
 */
export function coverage(specs: readonly GameSpecV1[], reading: Reading): number {
  const words = (shown: (kind: GameRole['kind']) => boolean): ReadonlySet<string> =>
    new Set(specs.flatMap((spec) => spec.roles.filter((role) => shown(role.kind)).flatMap((role) => wordsOf(role.label))));
  const heroes = words((kind) => kind === 'player');
  const things = words((kind) => SHOWN_KINDS.has(kind));
  const main = reading.foe === null && reading.item === null ? reading.roles.slice(0, 1).map((role) => role.noun) : [reading.foe, reading.item].filter((noun) => noun !== null);
  const hero = reading.hero !== null && heroes.has(headOf(reading.hero)) ? 1 : 0;
  const place = reading.world !== null && specs.some((spec) => lookOf(spec.theme) === reading.world) ? 1 : 0;
  return hero + main.filter((noun) => things.has(headOf(noun))).length + place;
}

/** Ukáže hra po čtení z rolí čtení aspoň tolik jako rychlá hra (`quick`, řetěz = jeho kola)? Stejně = dřívější pravidlo. */
export function namesNoLess(quick: readonly GameSpecV1[], read: GameSpecV1, reading: Reading): boolean {
  return coverage([read], reading) >= coverage(quick, reading);
}
