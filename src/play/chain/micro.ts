/**
 * Mikrohry řetězu (P56C T4): krátká kola nad stávajícími smyčkami, každé ověřené robotem na semínkách
 * `[1, 2, 8, 9, 13, 20]` (`__tests__/micro.test.ts`, kalibrace v `evals/play/p56c/micro-cost.md`).
 *
 * Kolo je obyčejný `GameSpecV1` – jádro, kompilátor ani generátory se nemění. Mikro cíl žije ve specu:
 * parametry žánru zkrátí úroveň (mimo `readGenreSpec`, jehož meze hlídají celou hru 30–90 s), `withDepth`
 * dá jeden život a cíl skóre, hodiny kola nese buď vestavěné `time_limit` (`achieve`), nebo pravidlo
 * `every` s výhrou (`survive`). Svět kola je tak čistá funkce `(spec, seed)`.
 *
 * Prohrávací hodiny `time_limit` kompilátor zaokrouhlí na nejméně 10 s (`limitSeconds` v `arcade/compile.ts`):
 * kolo `achieve`, které hráč nestihne, skončí prohrou v 10 s. Kratší mez by změnila uložené hry s krátkým
 * limitem a pravidlo `every` s prohrou neprojde důkazem sloves (robot, který vyhraje, ho nikdy nespustí).
 */

import { ARCADE_HZ } from '../arcade/contract';
import { withDepth } from '../compose/compile';
import { compileGenre } from '../genre';
import type { GenreId, GenreSpec } from '../genre/contract';
import type { ControlId, GameSpecV1 } from '../spec';

/** `achieve` = udělej cíl do vypršení hodin, jinak prohra; `survive` = vydrž hodiny. */
export type MicroKind = 'achieve' | 'survive';

/** `žánr.režim`; boss stejné smyčky má příponu `.boss`. */
export type MicroKey = `${GenreId}.${string}`;

export interface MicroEntry {
  readonly key: MicroKey;
  /** Ovládání přeloženého kola – řetěz počítá různá ovládání podle něj. */
  readonly control: ControlId;
  readonly kind: MicroKind;
  /** Hodiny kola 1 v sekundách (boss do 15). */
  readonly seconds: number;
  /** Jen `survive`: nejkratší hodiny v pozdním kole (nečinný musí prohrát dřív). */
  readonly fastest?: number;
  /** Karta se slovesem mezi koly, anglicky (`docs/brand/docs/11-voice-copy.md`). */
  readonly card: string;
  readonly boss?: true;
  /** Parametry žánru, které zkrátí úroveň na kolo. */
  readonly params?: Readonly<Record<string, number>>;
  /** Cílové skóre (`withDepth` → `score_bonus`), u `achieve` bez vlastního krátkého cíle. */
  readonly target?: number;
}

/**
 * Vypadly (robot do 8 s nevyhraje nebo nečinný nepropadne, důvody v `micro-cost.md`): `arena.*`, `throw`,
 * `voyage.race`, `slice` a dav jako boss. Fyzika (`ball`, `merge`, `push`), `quest.*` a `voyage.land` sem nepatří.
 */
export const MICRO: readonly MicroEntry[] = [
  { key: 'runner.default', control: 'runner', kind: 'survive', seconds: 6, fastest: 5, card: 'Run!', params: { lengthM: 60 } },
  { key: 'platformer.default', control: 'platform', kind: 'achieve', seconds: 8, card: 'Jump!', params: { lengthM: 60, items: 1 }, target: 10 },
  { key: 'hop.default', control: 'hop', kind: 'survive', seconds: 8, fastest: 7, card: 'Hop!', params: { rows: 18 } },
  { key: 'flap.default', control: 'flap', kind: 'survive', seconds: 6, fastest: 5, card: 'Flap!', params: { lengthM: 60 } },
  { key: 'shooter.default', control: 'shooter', kind: 'achieve', seconds: 8, card: 'Shoot!', params: { waves: 1, enemies: 4, targets: 3 } },
  { key: 'timing.stack', control: 'timing', kind: 'achieve', seconds: 8, card: 'Stack!', params: { rounds: 10 } },
  { key: 'timing.precision', control: 'timing', kind: 'achieve', seconds: 8, card: 'Time it!', params: { rounds: 10 } },
  { key: 'rhythm.default', control: 'rhythm', kind: 'survive', seconds: 6, fastest: 5, card: 'Tap the beat!', params: { seconds: 10 } },
  { key: 'catch.default', control: 'lanes', kind: 'achieve', seconds: 8, card: 'Catch!', params: { items: 10 }, target: 20 },
  { key: 'whack.default', control: 'lanes', kind: 'achieve', seconds: 8, card: 'Whack!', params: { targets: 10 }, target: 20 },
  { key: 'defense.default', control: 'lanes', kind: 'achieve', seconds: 8, card: 'Hold the line!', params: { enemies: 10 }, target: 50 },
  { key: 'duel.default', control: 'duel', kind: 'achieve', seconds: 8, card: 'Fight!', params: { rounds: 1 } },
  { key: 'crowd.default', control: 'crowd', kind: 'achieve', seconds: 8, card: 'Grow the crowd!', target: 20 },
  { key: 'shooter.default.boss', control: 'shooter', kind: 'achieve', seconds: 15, card: 'Shoot the boss!', boss: true, params: { waves: 2, enemies: 4, targets: 3 } },
  { key: 'defense.default.boss', control: 'lanes', kind: 'achieve', seconds: 15, card: 'Stop the horde!', boss: true, params: { enemies: 16 }, target: 240 },
  { key: 'duel.default.boss', control: 'duel', kind: 'achieve', seconds: 15, card: 'Beat the boss!', boss: true, params: { rounds: 2 } },
];

export const genreModeOf = (entry: MicroEntry): { readonly genre: GenreId; readonly mode: string } => {
  const [genre, mode] = entry.key.split('.') as [GenreId, string];
  return { genre, mode };
};

/** Hodiny kola `round` (od 0): přežití se po kolech zkracuje o 1 s až na `fastest`, `achieve` drží své. */
export const roundSeconds = (entry: MicroEntry, round: number): number => Math.max(entry.fastest ?? entry.seconds, entry.seconds - round);

/**
 * Kolo z návrhu žánru: parametry záznamu přebijí návrh i počty z věty (`counts` by úroveň zase natáhly),
 * jeden život, cíl skóre a hodiny kola.
 */
export function microSpec(draft: GenreSpec, entry: MicroEntry, round: number): GameSpecV1 {
  const { counts: _counts, ...rest } = draft;
  const spec = compileGenre((entry.params === undefined ? rest : { ...rest, params: { ...rest.params, ...entry.params } }) as GenreSpec);
  const seconds = roundSeconds(entry, round);
  const depth = { lives: 1, ...(entry.target === undefined ? {} : { targetScore: entry.target }) };
  if (entry.kind === 'achieve') return withDepth(spec, { ...depth, timeLimit: seconds });
  const lived = withDepth(spec, depth);
  return { ...lived, rules: [...(lived.rules ?? []), { id: 'micro_clock', verb: 'survive', when: { every: seconds * ARCADE_HZ }, do: [{ win: true }] }] };
}
