/**
 * P68R T6: výsledek na zapečetěné sadě P68R přepočítaný ze surových dat, ne opsaný (vzor P68 T15). G1 z řádků stráže
 * žánru nad sadou (`main` před P68R i `origin/main` po T5) a nad štítky P68 T2, G2 z herní brány, G3 ze snímků FPS,
 * G4 ze surových běhů A/B (`buildshift` změřený v T6, `minigolf`, `railfps`, `drawsave` převzaté z T15), G5 z počtů
 * testů. Prahy jsou z `p68/gates.json` (zmrazené v P68 T1). Hra je splněná jen s G1–G5 všemi; kategorie jen se všemi
 * svými hrami. Test selže, když `result.json` nebo `result.md` tvrdí „splněno“, které čísla nenesou – i opačně.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { P68R_HOLDOUT_SHA256, P68R_LABELS_SHA256, sha256Lf } from '../seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p68r');
const P68 = join(process.cwd(), 'evals', 'play', 'p68');
const readLf = (dir: string, name: string): string => readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
const json = <T>(name: string, dir = DIR): T => JSON.parse(readLf(dir, name)) as T;

const NEW = ['stunt', 'minigolf', 'railfps', 'buildshift', 'drawsave'] as const;
type Game = (typeof NEW)[number];
const CATEGORIES: Readonly<Record<string, readonly Game[]>> = { 'vozidla-sport': ['stunt', 'minigolf'], 'prvni-osoba': ['railfps'], stavba: ['buildshift', 'drawsave'] };
const GATE_IDS = ['G1', 'G2', 'G3', 'G4', 'G5'] as const;

interface Gates {
  readonly gates: {
    readonly 'G1-routing': { readonly newSentencesPerGame: number; readonly minRoutedToOwnGame: number };
    readonly 'G2-playable': { readonly sentencesPerGame: number; readonly minPassing: number };
    readonly 'G3-fps': { readonly fpsMedianMin: number; readonly frameP95MaxMs: number };
    readonly 'G4-time-to-playable': { readonly failedRunsMax: number; readonly medianMaxSec: number; readonly pairedMaxOverMainSec: number };
  };
}
interface Sentence { readonly id: string; readonly half: 'new' | 'general'; readonly game: string; readonly text: string }
interface RouteRow { readonly text: string; readonly sets: readonly string[]; readonly best: string; readonly acceptable: readonly string[]; readonly genre: string; readonly draft: string }
interface GateRow { readonly game: string; readonly sentence: string; readonly failed: string | null; readonly win: boolean; readonly lose: boolean; readonly actions: boolean }
interface FpsRow { readonly game: string; readonly project: string; readonly gated: boolean; readonly fpsMedian: number; readonly frameP95Ms: number }
/** `target` = id věty sady, `pair` = `<dávka>:<pár>` (páry se číslují v každé dávce měření zvlášť). */
interface Run { readonly profile: string; readonly target: string; readonly side: 'A' | 'B'; readonly pair: string; readonly playable: boolean; readonly ms: number | null }
interface G4 { readonly targets: Readonly<Record<string, Game>>; readonly runs: readonly Run[] }
interface Result {
  readonly holdout: { readonly sha256: string; readonly openedAt: string; readonly sentences: number };
  readonly g1: { readonly perGame: Readonly<Record<Game, { readonly n: number; readonly routedToOwn: number; readonly t15: number }>> };
  readonly g2: { readonly perGame: Readonly<Record<Game, { readonly n: number; readonly pass: number }>> };
  readonly g4: G4;
  readonly g5: { readonly tests: readonly { readonly file: string; readonly passed: number; readonly failed: number; readonly skipped: number }[] };
  readonly g6: { readonly measured: boolean; readonly why: string };
  readonly g7: { readonly measured: boolean; readonly why: string };
  readonly verdict: {
    readonly games: Readonly<Record<string, { readonly pass: boolean; readonly unmet: readonly string[] }>>;
    readonly categories: Readonly<Record<string, { readonly pass: boolean }>>;
  };
}

const gates = json<Gates>('gates.json', P68).gates;
const result = json<Result>('result.json');
const t15 = json<{ g1: { perGame: Record<Game, { routedToOwn: number }> }; g4: G4 }>('result.json', P68);
const opened = json<{ sha256: string; openedAt: string }>('holdout-opened.json');
const holdout = json<{ sentences: Sentence[] }>('holdout.json').sentences;
const md = readLf(DIR, 'result.md');

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
const routeOf = (name: string): Map<string, RouteRow> => new Map(json<{ rows: RouteRow[] }>(name).rows.map((row) => [row.text, row]));
const isNew = (genre: string): boolean => (NEW as readonly string[]).includes(genre);

// G1 – směrování rychlé hry (bez modelu).
const holdBranch = routeOf('route-holdout-branch.json');
const holdMain = routeOf('route-holdout-main.json');
const t2Branch = routeOf('route-branch.json');
const t2Main = routeOf('route-main.json');
const wrongIn = (rows: readonly RouteRow[]): number => rows.filter((row) => row.best !== 'none' && !row.acceptable.includes(row.genre)).length;
const generalRows = (route: Map<string, RouteRow>): RouteRow[] => holdout.filter((s) => s.half === 'general').map((s) => route.get(s.text)!);
const test200 = (route: Map<string, RouteRow>): RouteRow[] => [...route.values()].filter((row) => row.sets.some((set) => set.startsWith('p30/test-200.json#')));
const oldToOld = (before: Map<string, RouteRow>, after: Map<string, RouteRow>): number =>
  [...after.values()].filter((row) => {
    const was = before.get(row.text)!;
    return was.genre !== row.genre && !isNew(was.genre) && !isNew(row.genre);
  }).length;
const generalOk =
  wrongIn(generalRows(holdBranch)) <= wrongIn(generalRows(holdMain)) &&
  wrongIn(test200(t2Branch)) <= wrongIn(test200(t2Main)) &&
  oldToOld(holdMain, holdBranch) === 0 &&
  oldToOld(t2Main, t2Branch) === 0;
const routedToOwn = (game: Game): number => holdout.filter((s) => s.half === 'new' && s.game === game && holdBranch.get(s.text)!.draft === game).length;

// G2 – herní brána na všech 15 větách hry; pád překladu i věta poslaná jinam je ve jmenovateli.
const gateRows = json<{ results: GateRow[] }>('gameplay-holdout.json').results;
const playable = (game: Game): { n: number; pass: number } => {
  const rows = gateRows.filter((row) => row.game === game);
  return { n: rows.length, pass: rows.filter((row) => row.failed === null && row.win && row.lose && row.actions).length };
};

// G3 – FPS na emulovaném telefonu (hradí jen profily s `gated`).
const fps = json<{ gate: { vsyncJitterMs: number }; results: Record<string, FpsRow> }>('fps-holdout.json');
const fpsRows = Object.values(fps.results);
const fpsOk = (game: Game): boolean => {
  const rows = fpsRows.filter((row) => row.game === `p68-${game}` && row.gated);
  return rows.length > 0 && rows.every((row) => row.fpsMedian >= gates['G3-fps'].fpsMedianMin && row.frameP95Ms <= gates['G3-fps'].frameP95MaxMs + fps.gate.vsyncJitterMs);
};

// G4 – čerstvé páry A (`main`) / B (větev). Hra změřená v T6 bere své běhy, jinak běhy T15; neměřená hra bránu nemá.
const runsOf = (game: Game): readonly Run[] => {
  const fresh = result.g4.runs.filter((run) => result.g4.targets[run.target] === game);
  return fresh.length > 0 ? fresh : t15.g4.runs.filter((run) => t15.g4.targets[run.target] === game);
};
const timeOk = (game: Game): boolean => {
  const runs = runsOf(game);
  if (runs.length === 0) return false;
  const g4 = gates['G4-time-to-playable'];
  if (runs.filter((run) => !run.playable).length > g4.failedRunsMax) return false;
  const desktopB = runs.filter((run) => run.profile === 'desktop' && run.side === 'B').map((run) => run.ms!);
  if (desktopB.length === 0 || median(desktopB) > g4.medianMaxSec * 1000) return false;
  return ['desktop', 'pixel7-cpu4'].every((profile) => {
    const pairs = new Map<string, { A?: number; B?: number }>();
    for (const run of runs.filter((r) => r.profile === profile)) pairs.set(run.pair, { ...pairs.get(run.pair), [run.side]: run.ms! });
    const deltas = [...pairs.values()].filter((p) => p.A !== undefined && p.B !== undefined).map((p) => p.B! - p.A!);
    return deltas.length > 0 && median(deltas) <= g4.pairedMaxOverMainSec * 1000;
  });
};

// G5 – determinismus: otisky a kolo sdílení bez přeskočení.
const g5Ok = result.g5.tests.length >= 4 && result.g5.tests.every((test) => test.passed > 0 && test.failed === 0 && test.skipped === 0);

const computed = Object.fromEntries(
  NEW.map((game) => {
    const gate: Record<(typeof GATE_IDS)[number], boolean> = {
      G1: routedToOwn(game) >= gates['G1-routing'].minRoutedToOwnGame && generalOk,
      G2: playable(game).n === gates['G2-playable'].sentencesPerGame && playable(game).pass >= gates['G2-playable'].minPassing,
      G3: fpsOk(game),
      G4: timeOk(game),
      G5: g5Ok,
    };
    return [game, { gate, pass: GATE_IDS.every((id) => gate[id]) }];
  }),
) as Record<Game, { gate: Record<(typeof GATE_IDS)[number], boolean>; pass: boolean }>;

/** Řádek tabulky `result.md`, který začíná jménem hry nebo kategorie v obrácených uvozovkách. */
const mdRow = (name: string): string => md.split('\n').find((line) => line.startsWith(`| \`${name}\` |`)) ?? '';
const claims = (line: string): 'splněno' | 'nesplněno' | null => (line.includes('**nesplněno**') ? 'nesplněno' : line.includes('**splněno**') ? 'splněno' : null);

describe('P68R T6 sealed holdout result', () => {
  it('names the opened set: sealed sentence and label hashes, the time holdout-opened.json recorded, 105 sentences', () => {
    expect(opened.sha256).toBe(P68R_HOLDOUT_SHA256);
    expect(sha256Lf(readLf(DIR, 'holdout.json'))).toBe(P68R_HOLDOUT_SHA256);
    expect(sha256Lf(readLf(DIR, 'holdout-labels.json'))).toBe(P68R_LABELS_SHA256);
    expect(result.holdout.sha256).toBe(P68R_HOLDOUT_SHA256);
    expect(result.holdout.openedAt).toBe(opened.openedAt);
    expect(result.holdout.sentences).toBe(105);
    expect(holdout).toHaveLength(105);
  });

  it('measures every sentence: route rows on both sides, a gameplay row per new sentence', () => {
    for (const s of holdout) {
      expect(holdBranch.has(s.text), s.id).toBe(true);
      expect(holdMain.has(s.text), s.id).toBe(true);
    }
    for (const game of NEW) expect(playable(game).n, game).toBe(gates['G1-routing'].newSentencesPerGame);
  });

  it.each(NEW)('%s: result.json records the routing and gameplay counts the raw data give, and T15 as P68 recorded it', (game) => {
    expect(result.g1.perGame[game].routedToOwn).toBe(routedToOwn(game));
    expect(result.g2.perGame[game].pass).toBe(playable(game).pass);
    expect(result.g1.perGame[game].t15).toBe(t15.g1.perGame[game].routedToOwn);
  });

  it.each(NEW)('%s: result.json records the verdict and the unmet gates the raw data give', (game) => {
    const recorded = result.verdict.games[game]!;
    expect(recorded.pass).toBe(computed[game].pass);
    expect([...recorded.unmet].sort()).toEqual(GATE_IDS.filter((id) => !computed[game].gate[id]));
  });

  it.each(NEW)('%s: result.md claims what the raw data give', (game) => {
    expect(claims(mdRow(game))).toBe(computed[game].pass ? 'splněno' : 'nesplněno');
  });

  it.each(Object.keys(CATEGORIES))('category %s is met only when every one of its games is', (category) => {
    const pass = CATEGORIES[category]!.every((game) => computed[game].pass);
    expect(result.verdict.categories[category]!.pass).toBe(pass);
    expect(claims(mdRow(category))).toBe(pass ? 'splněno' : 'nesplněno');
  });

  it('says why G6 and G7 were not measured', () => {
    for (const gate of [result.g6, result.g7]) {
      expect(gate.measured).toBe(false);
      expect(gate.why.length).toBeGreaterThan(20);
    }
  });
});
