/**
 * P63 T3: hráč nepřejde z rychlé hry na hru po čtení, která z věty ukáže méně. Rytíř s drakem (h18) se starým čtením
 * hrál jízdu bez draka a řetěz ji publikoval vždy (P58F) – teď zůstane řetěz; s čtením T2 přepne souboj s drakem.
 * Pravidlo, které nikdy nepřepne, splní „nepřepne na horší“ samo, proto i věty, které přepnout musí (h12 Mars, h22 včela,
 * h15 plameny), a stejné pokrytí = dnešní pravidlo. Věty jdou cestou serveru přes diagnózu P63 (`gamesOf`), jako v T2.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import diagnosis from '../../../../evals/play/p63/diagnosis.json';
import { gamesOf, loadDeps } from '../../../../evals/play/p63/diagnose.mjs';
import readSet from '../../../../evals/play/p63/read-set.json';
import oldReadings from '../../../../evals/play/p63/readings.astra.json';
import p63Readings from '../../../../evals/play/p63/readings.p63.astra.json';
import { draftGameSpecWithMeta } from '../../draft';
import { coverage, namesNoLess } from '../../read/coverage';
import type { Reading } from '../../read/schema';
import type { GameSpecV1 } from '../../spec';
import { chainReasons } from '../decide';

type Rows = { readonly rows: readonly { readonly id: string; readonly models: Record<string, { readonly reading: Reading | null }> }[] };

const recorded = (file: Rows, id: string): Reading | null => file.rows.find((row) => row.id === id)?.models['astra@openai'].reading ?? null;
/** Čtení T1 – starý prompt čtečky (h18 = `voyage.race`). */
const oldReading = (id: string): Reading => recorded(oldReadings as Rows, id)!;
/** Čtení, které server dnes dostane: nový prompt T2, kde ho T2 přečetl, jinak čtení T1. */
const reading = (id: string): Reading => recorded(p63Readings as Rows, id) ?? oldReading(id);
const textOf = (id: string): string => readSet.sentences.find((row) => row.id === id)!.text;
const mainPublished = (id: string): boolean => diagnosis.all.find((row) => row.id === id)!.published;

/** Hra s rolemi `druh:popisek` (první je hrdina) v sadě světa `look`; zbytek specu je návrh věty. */
const BASE = draftGameSpecWithMeta('A knight fights a dragon in the forest', 1).spec;
const game = (look: NonNullable<GameSpecV1['theme']['look']>, ...roles: readonly string[]): GameSpecV1 => ({
  ...BASE,
  theme: { ...BASE.theme, look },
  roles: roles.map((role, index) => ({ id: `r${index}`, kind: role.split(':')[0] as GameSpecV1['roles'][number]['kind'], label: role.split(':')[1]!, count: 1 })),
});
const KNIGHT: Reading = { ...oldReading('h18'), hero: 'brave knight', foe: 'red dragons', item: 'gold coins', world: 'forest', roles: [{ noun: 'red dragons', kind: 'threat', count: null }] };

describe('coverage: the roles of the reading a game shows (P63 T3)', () => {
  it('counts the hero, the foe, the goal and the place, by the head word of the reading', () => {
    expect(coverage([game('forest', 'player:knight', 'hazard:dragon', 'collectible:gold coin')], KNIGHT)).toBe(4);
    // Jiná sada světa místo věty neukáže; drak jako kulisa nebo cíl cesty není nepřítel.
    expect(coverage([game('castle', 'player:knight', 'hazard:dragon', 'collectible:coin')], KNIGHT)).toBe(3);
    expect(coverage([game('forest', 'player:knight', 'prop:dragon', 'exit:dragon', 'collectible:coin')], KNIGHT)).toBe(3);
    expect(coverage([game('forest', 'player:car', 'hazard:log', 'collectible:turbo')], KNIGHT)).toBe(1);
  });

  it('a reading with no foe and no goal counts its first role; a chain counts what any round shows', () => {
    const bee: Reading = { ...KNIGHT, hero: 'bee', foe: null, item: null, world: 'meadow', roles: [{ noun: 'flowers', kind: 'target', count: null }] };
    expect(coverage([game('meadow', 'player:bee', 'chaser:flower')], bee)).toBe(3);
    expect(coverage([game('meadow', 'player:bee', 'hazard:car')], bee)).toBe(2);
    expect(coverage([game('meadow', 'player:knight', 'hazard:car'), game('forest', 'player:bee', 'collectible:flower')], bee)).toBe(3);
  });

  it('the reading game names no less: more or as much switches, less does not', () => {
    const quick = [game('forest', 'player:knight', 'hazard:dragon')];
    expect(namesNoLess(quick, game('forest', 'player:knight', 'hazard:dragon', 'collectible:coin'), KNIGHT)).toBe(true);
    expect(namesNoLess(quick, game('forest', 'player:knight', 'chaser:red dragon'), KNIGHT)).toBe(true);
    expect(namesNoLess(quick, game('forest', 'player:knight', 'hazard:log', 'collectible:turbo'), KNIGHT)).toBe(false);
  });
});

let deps: unknown;
// Návrh, řetěz i fyzika se načítají poprvé; pod zátěží celé sady to trvá déle než výchozích 10 s.
// P70A T2: nová věta hraje řetěz jen na výslovné přání; přepnutí na hru ze čtení platí pro řetězy uložené dřív, tak
// rychlou hru staví pravidlo před P70A (každý důvod `chainReasons`), jako diagnóza P63 (`diagnosis.json`).
beforeAll(async () => {
  const loaded = (await loadDeps()) as object;
  deps = { ...loaded, chainOrSingle: (...args: Parameters<typeof chainReasons>) => (chainReasons(...args).length > 0 ? 'chain' : 'single') };
}, 60_000);

describe('P63 T3: never switch to a reading game that names less of the sentence', () => {
  it('h18 with the old reading: the ride without the dragon does not replace the chain', () => {
    const { quickGame, readingGame, published, covered } = gamesOf(textOf('h18'), oldReading('h18'), deps);
    expect(quickGame.genre).toBe('chain');
    expect(readingGame?.genre).toBe('voyage.race');
    expect(readingGame!.cast.roles.some((role) => role.includes('dragon')), JSON.stringify(readingGame!.cast)).toBe(false);
    expect(covered!.reading).toBeLessThan(covered!.quick);
    expect(published).toBe(false);
  });

  it('h18 with the reading of T2: the duel with the dragon replaces the chain', () => {
    const { readingGame, published } = gamesOf(textOf('h18'), reading('h18'), deps);
    expect(readingGame?.genre).toBe('duel.default');
    expect(readingGame!.cast.roles.some((role) => role.includes('dragon')), JSON.stringify(readingGame!.cast)).toBe(true);
    expect(published).toBe(true);
  });

  // Kladné věty: pravidlo, které nikdy nepřepne, tu selže. h12 a h22 ukážou hrdinu, cíl i místo věty jako kola řetězu,
  // h15 navíc plameny, které řetěz nemá.
  it.each([
    { id: 'h12', more: false },
    { id: 'h22', more: false },
    { id: 'h15', more: true },
  ])('$id switches to the reading game', ({ id, more }) => {
    const { quickGame, published, covered } = gamesOf(textOf(id), reading(id), deps);
    expect(quickGame.genre).toBe('chain');
    expect(covered!.reading, JSON.stringify(covered)).toBe(more ? covered!.quick + 1 : covered!.quick);
    expect(published).toBe(true);
  });

  // Stejné pokrytí = dnešní pravidlo: řetěz přepne vždy (P58F), jedna hra jen když se od rychlé liší (`readingDiffers`).
  it.each(['h06', 's002', 'h10', 'h01', 'h02'])('%s with the same coverage publishes as on main', (id) => {
    const { published, covered } = gamesOf(textOf(id), reading(id), deps);
    expect(covered!.reading, JSON.stringify(covered)).toBe(covered!.quick);
    expect(published).toBe(mainPublished(id));
  });
});
