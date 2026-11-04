/**
 * P68T T3: verdikt na zapečetěné sadě P68T přepočítaný ze surových dat, ne opsaný (vzor P68R T6). G1 z řádků stráže
 * žánru nad sadou (`main` před P68T i `origin/main` po T2) a nad štítky P68 T2, G2 z herní brány. Prahy jsou
 * z `p68/gates.json` (zmrazené v P68 T1). P68T měří jen G1 a G2 – T2 měnil jen směrování. Test selže, když
 * `result.json` nebo `result.md` tvrdí „splněno“, které čísla nenesou – i opačně.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { P68T_HOLDOUT_SHA256, P68T_LABELS_SHA256, sha256Lf } from '../seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p68t');
const P68 = join(process.cwd(), 'evals', 'play', 'p68');
const P68R = join(process.cwd(), 'evals', 'play', 'p68r');
const readLf = (dir: string, name: string): string => readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
const json = <T>(name: string, dir = DIR): T => JSON.parse(readLf(dir, name)) as T;

const GAMES = ['minigolf', 'railfps', 'buildshift', 'drawsave'] as const;
type Game = (typeof GAMES)[number];
const NEW = new Set<string>(['stunt', ...GAMES]);

interface Sentence { readonly id: string; readonly half: 'new' | 'general'; readonly game: string; readonly text: string }
interface RouteRow { readonly text: string; readonly sets: readonly string[]; readonly best: string; readonly acceptable: readonly string[]; readonly genre: string; readonly draft: string }
interface GateRow { readonly game: string; readonly sentence: string; readonly failed: string | null; readonly win: boolean; readonly lose: boolean; readonly actions: boolean }
interface Gates {
  readonly gates: {
    readonly 'G1-routing': { readonly newSentencesPerGame: number; readonly minRoutedToOwnGame: number };
    readonly 'G2-playable': { readonly sentencesPerGame: number; readonly minPassing: number };
  };
}
interface Result {
  readonly holdout: { readonly sha256: string; readonly labelsSha256: string; readonly openedAt: string; readonly sentences: number };
  readonly g1: {
    readonly general: {
      readonly holdout: { readonly wrongMain: number; readonly wrongBranch: number };
      readonly test200: { readonly wrongMain: number; readonly wrongBranch: number };
      readonly movesHoldout: readonly string[];
      readonly movesT2: readonly string[];
    };
    readonly generalOk: boolean;
    readonly perGame: Readonly<Record<Game, { readonly n: number; readonly routedToOwn: number; readonly routedToOwnMain: number; readonly p68r: number }>>;
    readonly misses: Readonly<Record<Game, readonly string[]>>;
  };
  readonly g2: { readonly perGame: Readonly<Record<Game, { readonly n: number; readonly pass: number }>> };
  readonly verdict: { readonly games: Readonly<Record<Game, { readonly pass: boolean; readonly unmet: readonly string[] }>> };
}

const gates = json<Gates>('gates.json', P68).gates;
const result = json<Result>('result.json');
const p68r = json<{ g1: { perGame: Record<Game, { routedToOwn: number }> } }>('result.json', P68R);
const opened = json<{ sha256: string; openedAt: string }>('holdout-opened.json');
const holdout = json<{ sentences: Sentence[] }>('holdout.json').sentences;
const md = readLf(DIR, 'result.md');

const routeOf = (name: string): Map<string, RouteRow> => new Map(json<{ rows: RouteRow[] }>(name).rows.map((row) => [row.text, row]));
const holdBranch = routeOf('route-holdout-branch.json');
const holdMain = routeOf('route-holdout-main.json');
const t2Branch = routeOf('route-branch.json');
const t2Main = routeOf('route-main.json');

const wrongIn = (rows: readonly RouteRow[]): number => rows.filter((row) => row.best !== 'none' && !row.acceptable.includes(row.genre)).length;
const generalRows = (route: Map<string, RouteRow>): RouteRow[] => holdout.filter((s) => s.half === 'general').map((s) => route.get(s.text)!);
const test200 = (route: Map<string, RouteRow>): RouteRow[] => [...route.values()].filter((row) => row.sets.some((set) => set.startsWith('p30/test-200.json#')));
const oldToOld = (before: Map<string, RouteRow>, after: Map<string, RouteRow>): string[] =>
  [...after.values()].filter((row) => {
    const was = before.get(row.text)!;
    return was.genre !== row.genre && !NEW.has(was.genre) && !NEW.has(row.genre);
  }).map((row) => row.text);
const generalOk =
  wrongIn(generalRows(holdBranch)) <= wrongIn(generalRows(holdMain)) &&
  wrongIn(test200(t2Branch)) <= wrongIn(test200(t2Main)) &&
  oldToOld(holdMain, holdBranch).length === 0 &&
  oldToOld(t2Main, t2Branch).length === 0;

const aimedAt = (game: Game): Sentence[] => holdout.filter((s) => s.half === 'new' && s.game === game);
const routedToOwn = (game: Game, route: Map<string, RouteRow>): number => aimedAt(game).filter((s) => route.get(s.text)!.draft === game).length;
const missesOf = (game: Game): string[] => aimedAt(game).filter((s) => holdBranch.get(s.text)!.draft !== game).map((s) => `${s.id} ${holdBranch.get(s.text)!.draft}`);

// G2 – herní brána na všech 15 větách hry; věta poslaná jinam je ve jmenovateli jako selhání.
const gateRows = json<{ results: GateRow[] }>('gameplay-holdout.json').results;
const playable = (game: Game): { n: number; pass: number } => {
  const rows = gateRows.filter((row) => row.game === game);
  return { n: rows.length, pass: rows.filter((row) => row.failed === null && row.win && row.lose && row.actions).length };
};

const computed = Object.fromEntries(
  GAMES.map((game) => {
    const gate = {
      G1: routedToOwn(game, holdBranch) >= gates['G1-routing'].minRoutedToOwnGame && generalOk,
      G2: playable(game).n === gates['G2-playable'].sentencesPerGame && playable(game).pass >= gates['G2-playable'].minPassing,
    };
    return [game, { gate, pass: gate.G1 && gate.G2 }];
  }),
) as Record<Game, { gate: { G1: boolean; G2: boolean }; pass: boolean }>;

const mdRow = (name: string): string => md.split('\n').find((line) => line.startsWith(`| \`${name}\` |`)) ?? '';
const claims = (line: string): 'splněno' | 'nesplněno' | null => (line.includes('**nesplněno**') ? 'nesplněno' : line.includes('**splněno**') ? 'splněno' : null);

describe('P68T T3 sealed holdout result', () => {
  it('names the opened set: sealed sentence and label hashes, the time holdout-opened.json recorded, 90 sentences', () => {
    expect(opened.sha256).toBe(P68T_HOLDOUT_SHA256);
    expect(sha256Lf(readLf(DIR, 'holdout.json'))).toBe(P68T_HOLDOUT_SHA256);
    expect(sha256Lf(readLf(DIR, 'holdout-labels.json'))).toBe(P68T_LABELS_SHA256);
    expect(result.holdout.sha256).toBe(P68T_HOLDOUT_SHA256);
    expect(result.holdout.labelsSha256).toBe(P68T_LABELS_SHA256);
    expect(result.holdout.openedAt).toBe(opened.openedAt);
    expect(result.holdout.sentences).toBe(90);
    expect(holdout).toHaveLength(90);
  });

  it('measures every sentence: route rows on both sides, 15 aimed sentences and gameplay rows per game', () => {
    for (const s of holdout) {
      expect(holdBranch.has(s.text), s.id).toBe(true);
      expect(holdMain.has(s.text), s.id).toBe(true);
    }
    for (const game of GAMES) {
      expect(aimedAt(game), game).toHaveLength(gates['G1-routing'].newSentencesPerGame);
      expect(playable(game).n, game).toBe(gates['G2-playable'].sentencesPerGame);
    }
  });

  it('records the general sentences, test200 and the moves between old genres the raw rows give', () => {
    expect(result.g1.general.holdout).toMatchObject({ wrongMain: wrongIn(generalRows(holdMain)), wrongBranch: wrongIn(generalRows(holdBranch)) });
    expect(result.g1.general.test200).toMatchObject({ wrongMain: wrongIn(test200(t2Main)), wrongBranch: wrongIn(test200(t2Branch)) });
    expect(result.g1.general.movesHoldout).toHaveLength(oldToOld(holdMain, holdBranch).length);
    expect(result.g1.general.movesT2).toHaveLength(oldToOld(t2Main, t2Branch).length);
    expect(result.g1.generalOk).toBe(generalOk);
  });

  it.each(GAMES)('%s: result.json records the routing and gameplay counts the raw data give, and P68R as P68R recorded it', (game) => {
    expect(result.g1.perGame[game].routedToOwn).toBe(routedToOwn(game, holdBranch));
    expect(result.g1.perGame[game].routedToOwnMain).toBe(routedToOwn(game, holdMain));
    expect(result.g1.perGame[game].p68r).toBe(p68r.g1.perGame[game].routedToOwn);
    expect(result.g1.misses[game]).toEqual(missesOf(game));
    expect(result.g2.perGame[game].pass).toBe(playable(game).pass);
  });

  it.each(GAMES)('%s: result.json and result.md record the verdict the raw data give', (game) => {
    const recorded = result.verdict.games[game];
    expect(recorded.pass).toBe(computed[game].pass);
    expect([...recorded.unmet].sort()).toEqual((['G1', 'G2'] as const).filter((id) => !computed[game].gate[id]));
    expect(claims(mdRow(game))).toBe(computed[game].pass ? 'splněno' : 'nesplněno');
  });
});
