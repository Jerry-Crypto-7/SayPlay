// P68I T14: verdikt hybridu se přepočítá z `hybrid/pilot.json`; `decision.json` a README ho jen opisují.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = path.join(process.cwd(), 'evals', 'play', 'p68');
const json = <T>(rel: string): T => JSON.parse(readFileSync(path.join(DIR, rel), 'utf8')) as T;

interface PilotRow { readonly validData: number; readonly botPassed: boolean }
interface Pilot {
  readonly ledger: { readonly mode: string };
  readonly attempts: number;
  readonly results: readonly PilotRow[];
  readonly spentUsd: number | null;
  readonly extensionMs: { readonly aiVersionP95?: number };
  readonly judge: { readonly run: boolean; readonly wouldPlayWithScript?: number; readonly wouldPlayWithout?: number };
}
interface Decision { readonly verdict: 'eligible' | 'off'; readonly reasons: readonly string[]; readonly engineDiffs: number; readonly passRateOfAttempts: number }

/** AC T14: `eligible` jen když platí všech pět podmínek; jinak `off` s každým důvodem zvlášť. */
function verdictOf(pilot: Pilot, engineDiffs: number): Omit<Decision, 'engineDiffs'> {
  const reasons: string[] = [];
  const passing = pilot.results.filter((row) => row.validData > 0 && row.botPassed).length;
  // Selhání jsou ve jmenovateli: dělí se všemi pokusy, ne větami ani úspěšnými pokusy.
  const passRateOfAttempts = Number((passing / Math.max(1, pilot.attempts)).toFixed(3));
  if (passRateOfAttempts < 0.9) reasons.push(`valid data passing the bot ${passing}/${pilot.attempts} attempts, below 90 %`);
  if (engineDiffs !== 0) reasons.push(`${engineDiffs} differences between Node, Chromium and WebKit`);
  const { judge } = pilot;
  if (!judge.run || judge.wouldPlayWithScript === undefined || judge.wouldPlayWithout === undefined) reasons.push('blind judge did not run, so "would play" with a script is unmeasured');
  else if (judge.wouldPlayWithScript < judge.wouldPlayWithout + 0.1) reasons.push(`"would play" with a script ${judge.wouldPlayWithScript} is below ${judge.wouldPlayWithout} + 0.10`);
  const p95 = pilot.extensionMs.aiVersionP95;
  if (p95 === undefined) reasons.push('p95 extension of the AI version unmeasured (astra wrote nothing)');
  else if (p95 > 30_000) reasons.push(`p95 extension of the AI version ${p95} ms, above 30 s`);
  if (pilot.ledger.mode === 'fast-only' || pilot.spentUsd === null) reasons.push('spend on the AI version not recorded (no measuring ledger, stand-in writer)');
  return { verdict: reasons.length === 0 ? 'eligible' : 'off', reasons, passRateOfAttempts };
}

const GOOD: Pilot = {
  ledger: { mode: 'eval' },
  attempts: 20,
  results: Array.from({ length: 20 }, () => ({ validData: 1, botPassed: true })),
  spentUsd: 0.35,
  extensionMs: { aiVersionP95: 24_000 },
  judge: { run: true, wouldPlayWithScript: 0.7, wouldPlayWithout: 0.55 },
};

describe('hybrid verdict (P68 T14)', () => {
  it('decision.json is the verdict recomputed from pilot.json', () => {
    const decision = json<Decision>('hybrid/decision.json');
    expect({ verdict: decision.verdict, reasons: decision.reasons, passRateOfAttempts: decision.passRateOfAttempts }).toEqual(verdictOf(json<Pilot>('hybrid/pilot.json'), decision.engineDiffs));
  });

  it('the README states the same verdict', () => {
    const readme = readFileSync(path.join(DIR, 'README.md'), 'utf8');
    expect(readme).toContain(`**Verdikt T14: \`${json<Decision>('hybrid/decision.json').verdict}\`**`);
  });

  it('a pilot meeting every condition is eligible', () => {
    expect(verdictOf(GOOD, 0)).toEqual({ verdict: 'eligible', reasons: [], passRateOfAttempts: 1 });
  });

  it('70 % of attempts passing is off even with everything else met', () => {
    const results = GOOD.results.map((row, i) => (i < 14 ? row : { validData: 1, botPassed: false }));
    expect(verdictOf({ ...GOOD, results }, 0).verdict).toBe('off');
  });

  it('a failed attempt counts in the denominator', () => {
    const results = GOOD.results.map((row, i) => (i < 18 ? row : { validData: 0, botPassed: false }));
    expect(verdictOf({ ...GOOD, results }, 0).verdict).toBe('eligible');
    expect(verdictOf({ ...GOOD, attempts: 21, results }, 0).verdict).toBe('off');
  });

  it('an engine difference, a weak judge, a slow AI version or no ledger each turn it off', () => {
    expect(verdictOf(GOOD, 1).verdict).toBe('off');
    expect(verdictOf({ ...GOOD, judge: { run: true, wouldPlayWithScript: 0.6, wouldPlayWithout: 0.55 } }, 0).verdict).toBe('off');
    expect(verdictOf({ ...GOOD, extensionMs: { aiVersionP95: 31_000 } }, 0).verdict).toBe('off');
    expect(verdictOf({ ...GOOD, ledger: { mode: 'fast-only' } }, 0).verdict).toBe('off');
  });
});
