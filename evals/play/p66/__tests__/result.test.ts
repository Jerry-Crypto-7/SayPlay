/**
 * P66 T16: zapečetěná brána sloučení přepočítaná ze surových dat, ne opsaná (vzor P61 T8, P63 T6). Mediány soudce se
 * počítají znovu ze skóre po větách (obecná polovina podle `half` v `holdout.json`), start ze surových běhů A/B, FPS ze
 * surových snímků a žánr z řádků `route-main.json` / `route-branch.json`. Prahy jsou tady z plánu P66, ne z výsledku.
 * Brána pod prahem test shodí – jedině když ji `result.json` (`verdict.unmet`) i README zapisují jako nesplněnou, je to
 * zaznamenaný verdikt a sada zůstane zelená. Tvrzená brána, kterou čísla nenesou, i „nesplněná“ brána, kterou čísla
 * nesou, test shodí. G5 (robot) a G7 (e2e) jsou počty z běhů; test hlídá, že pokrývají každou hru a každý spec.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const DIR = join(process.cwd(), 'evals', 'play', 'p66');
const readLf = (name: string): string => readFileSync(join(DIR, name), 'utf8').replace(/\r\n/g, '\n');
const json = <T>(name: string): T => JSON.parse(readLf(name)) as T;

const P66_HOLDOUT_SHA256 = '42bf10ccca56ea5dab0b0c06cca9401701b3bb3980794c31da9a853c99c9e611';
const NEW_GENRES = ['survivor', 'hole', 'steal', 'sort', 'arrows'];

interface Score { readonly fidelity: number; readonly wouldPlay: number }
interface Gate { readonly id: string; readonly pass: boolean; readonly value?: number }
interface Pair { readonly id: string; readonly A: readonly number[]; readonly B: readonly number[] }
interface RouteRow { readonly text: string; readonly sets: readonly string[]; readonly best: string; readonly acceptable: readonly string[]; readonly genre: string }
interface Route { readonly rows: readonly RouteRow[] }
interface Result {
  readonly holdout: { readonly sha256: string; readonly openedAt: string; readonly commit: string; readonly sentences: number };
  readonly plan: readonly { readonly id: string; readonly rows: readonly { readonly kind: string }[] }[];
  readonly sentences: readonly { readonly id: string; readonly scores: Readonly<Record<string, Score>> }[];
  readonly gates: readonly Gate[];
  readonly verdict: { readonly pass: boolean; readonly unmet: readonly string[]; readonly label: string };
  readonly timing: { readonly runs: number; readonly profiles: Readonly<Record<string, readonly Pair[]>> };
  readonly fps: { readonly old: readonly { readonly genre: string; readonly A: readonly number[]; readonly B: readonly number[] }[]; readonly new: readonly { readonly genre: string; readonly B: readonly number[] }[] };
  readonly robot: { readonly games: number; readonly botWins: number; readonly idleLoses: number; readonly replayEqual: number; readonly matchesServer: number };
  readonly hashes: { readonly tests: number; readonly passed: number; readonly v6: { readonly tests: number; readonly passed: number } };
  readonly losable: Readonly<Record<string, { readonly test: string; readonly pass: boolean }>>;
  readonly e2e: { readonly specs: readonly { readonly spec: string; readonly passed: number; readonly failed: number; readonly redOnMain: number }[] };
  readonly spend: { readonly total: number; readonly cap: number };
}

const result = json<Result>('result.json');
const opened = json<{ sha256: string; openedAt: string; commit: string }>('holdout-opened.json');
const holdout = json<{ sentences: { id: string; half: 'new' | 'general' }[] }>('holdout.json');
const baselineFps = json<{ slowest: { genre: string; fpsP50: number } }>('baseline-fps.json');
const readme = readLf('README.md');
const section = readme.slice(readme.indexOf('## T16'));

const round = (x: number): number => Math.round(x * 1000) / 1000;
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
/** V tisícinách, ať 0,48 ≥ 0,50 − 0,02 neztratí plovoucí čárka. */
const atLeast = (x: number, floor: number): boolean => Math.round(x * 1000) >= Math.round(floor * 1000);

/** Hra, kterou hráč hraje po příchodu čtení: hra ze čtení, když je na listu, jinak rychlá hra. */
function played(id: string, name: 'main' | 'p66'): Score {
  const kinds = result.plan.find((item) => item.id === id)!.rows.map((row) => row.kind);
  const scores = result.sentences.find((row) => row.id === id)!.scores;
  return (kinds.includes(`${name}-reading`) ? scores[`${name}-reading`] : scores[`${name}-quick`])!;
}
const halfOf = new Map(holdout.sentences.map((s) => [s.id, s.half]));
/** Táž sada listů pro obě strany: jen věty, kde soudce dal skóre rychlé hře `main` i větve. */
const shared = result.sentences.filter((row) => row.scores['main-quick'] && row.scores['p66-quick']).map((row) => row.id);
const side = (kind: string, ids: readonly string[] = shared) => {
  const scores = ids.map((id) => (kind.endsWith('-after') ? played(id, kind.startsWith('main') ? 'main' : 'p66') : result.sentences.find((row) => row.id === id)!.scores[kind]!));
  return { fidelity: round(median(scores.map((s) => s.fidelity))), wouldPlay: round(median(scores.map((s) => s.wouldPlay))) };
};
const general = shared.filter((id) => halfOf.get(id) === 'general');

const computed: Record<string, boolean> = {
  G1: atLeast(side('p66-quick').wouldPlay, side('main-quick').wouldPlay + 0.05) && atLeast(side('p66-quick', general).wouldPlay, side('main-quick', general).wouldPlay - 0.02),
  G2: atLeast(side('p66-quick').fidelity, side('main-quick').fidelity - 0.02) && atLeast(side('p66-after').fidelity, side('main-after').fidelity - 0.02),
  G3: median(result.timing.profiles['pixel7-cpu4']!.flatMap((row) => row.B.map((b, i) => b - row.A[i]!))) <= 200,
  G4:
    median(result.fps.old.map((row) => median(row.B) / median(row.A))) >= 0.95 &&
    NEW_GENRES.every((genre) => median(result.fps.new.find((row) => row.genre === genre)!.B) >= 0.95 * baselineFps.slowest.fpsP50),
};
{
  const main = json<Route>('route-main.json');
  const branch = json<Route>('route-branch.json');
  const wrongRate = (route: Route): number => {
    const counted = route.rows.filter((row) => row.sets.some((set) => set.startsWith('p30/test-200.json#')) && row.best !== 'none');
    return counted.filter((row) => !row.acceptable.includes(row.genre)).length / counted.length;
  };
  const before = new Map(main.rows.map((row) => [row.text, row.genre]));
  const oldToOld = branch.rows.filter((row) => before.get(row.text) !== row.genre && !NEW_GENRES.includes(row.genre)).length;
  computed.G6 = wrongRate(branch) <= wrongRate(main) && oldToOld === 0;
}

describe('P66 T16 sealed merge gate', () => {
  it('opens the sealed set once: the result names the sha and the time holdout-opened.json recorded', () => {
    expect(result.holdout.sha256).toBe(P66_HOLDOUT_SHA256);
    expect(opened.sha256).toBe(P66_HOLDOUT_SHA256);
    expect(result.holdout.openedAt).toBe(opened.openedAt);
    expect(result.holdout.sentences).toBe(30);
    expect(shared.length).toBe(30);
    expect(general.length).toBe(15);
  });

  it.each(['G1', 'G2', 'G3', 'G4', 'G6'])('%s in result.json is what the raw data says, and an unmet gate is recorded as unmet', (id) => {
    const gate = result.gates.find((item) => item.id === id)!;
    expect(gate.pass).toBe(computed[id]);
    expect(result.verdict.unmet.includes(id)).toBe(!computed[id]);
    if (!computed[id]) expect(section).toMatch(new RegExp(`${id}[^\\n]*nesplněn`));
  });

  it('G5 covers every game of the set: the robot wins, the idle player loses, replays match, every new genre can be lost', () => {
    const games = result.plan.reduce((sum, item) => sum + item.rows.filter((row) => row.kind.startsWith('p66-')).length, 0);
    expect(result.robot.games).toBeGreaterThanOrEqual(games);
    const passed = result.hashes.tests > 0 && result.hashes.passed === result.hashes.tests && result.hashes.v6.tests > 0 && result.hashes.v6.passed === result.hashes.v6.tests && [result.robot.botWins, result.robot.idleLoses, result.robot.replayEqual, result.robot.matchesServer].every((n) => n === result.robot.games) && NEW_GENRES.every((genre) => result.losable[genre]?.pass === true);
    expect(result.gates.find((item) => item.id === 'G5')!.pass).toBe(passed);
    expect(result.verdict.unmet.includes('G5')).toBe(!passed);
  });

  it('G7 passes only when every spec is green or red on main too', () => {
    const passed = result.e2e.specs.every((spec) => spec.failed <= spec.redOnMain);
    expect(result.e2e.specs.some((spec) => spec.spec === 'interface-language')).toBe(true);
    for (const genre of NEW_GENRES) expect(result.e2e.specs.some((spec) => spec.spec === `play-${genre}`)).toBe(true);
    expect(result.gates.find((item) => item.id === 'G7')!.pass).toBe(passed);
    expect(result.verdict.unmet.includes('G7')).toBe(!passed);
  });

  it('the verdict follows the gates and the README says the same', () => {
    expect(result.gates.map((gate) => gate.id)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);
    expect(result.verdict.unmet).toEqual(result.gates.filter((gate) => !gate.pass).map((gate) => gate.id));
    expect(result.verdict.pass).toBe(result.verdict.unmet.length === 0);
    const label = result.verdict.pass ? 'připraveno k sloučení' : 'nepřipraveno k sloučení';
    expect(result.verdict.label).toBe(label);
    expect(section).toContain(`**${label}**`);
  });

  it('reader spend of the whole plan stays within 4 USD', () => {
    expect(result.spend.cap).toBe(4);
    expect(result.spend.total).toBeLessThanOrEqual(4);
  });
});
