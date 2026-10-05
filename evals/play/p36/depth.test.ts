/**
 * Měřítko hloubky (P36A T1). Neměří znovu – to dělá `depth.measure.ts` –,
 * hlídá commitnutý `depth.json`:
 *
 * - každá věta obou sad je v reportu právě jednou a se svým textem;
 * - souhrn je spočítaný z řádků (nikdo ho nepřepsal ručně);
 * - čtečka čísel z věty čísla opravdu čte – v obou sadách dnes žádné číslo
 *   životů, skóre ani času není, takže rozbitá čtečka by vypadala stejně;
 * - **cíle plánu** (≥ 85 % v pásmu 30–90 s, nečinný prohraje u ≥ 95 %,
 *   životy > 1 u ≥ 80 %) jsou `it.fails`: dnes je report pod nimi, a proto
 *   test prochází. Úloha, která cíl splní a report přeměří (T2 životy, T3/T4
 *   nečinný a délka), uvidí svůj test zčervenat a přepne ho na `it`.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEPTH_TARGETS, type DepthReport, depthSentences, saidNumbers, summaries } from './depth';

const report = JSON.parse(readFileSync(new URL('./depth.json', import.meta.url), 'utf8')) as DepthReport;

describe('depth.json – the depth baseline over the demand and dev sentences', () => {
  it('has every sentence of both sets exactly once, with its text', () => {
    const expected = depthSentences();
    expect(expected).toHaveLength(260);
    expect(report.rows.map(({ set, id, text }) => ({ set, id, text }))).toEqual(expected);
    expect(new Set(report.rows.map((row) => `${row.set}:${row.id}`)).size).toBe(report.rows.length);
  });

  it('computes the summary from the rows', () => {
    expect(report.summary).toEqual(summaries(report.rows));
  });

  it('marks a run in the band only when the robot won in 30–90 s', () => {
    for (const row of report.rows) {
      expect(row.winSeconds === null, row.id).toBe(row.bot.end !== 'won');
      expect(row.inBand, row.id).toBe(row.winSeconds !== null && row.winSeconds >= 30 && row.winSeconds <= 90);
    }
  });
});

describe('numbers a sentence says', () => {
  it.each([
    ['a platformer with three lives', { lives: 3, score: null, seconds: null }],
    ['you have 5 lives to escape the castle', { lives: 5, score: null, seconds: null }],
    ['one life, no second chances', { lives: 1, score: null, seconds: null }],
    ['a runner with no lives left', { lives: 1, score: null, seconds: null }],
    ['score 200 points before time runs out', { lives: null, score: 200, seconds: null }],
    ['get a score of 50 in the arena', { lives: null, score: 50, seconds: null }],
    ['survive 30 seconds in a shark tank', { lives: null, score: null, seconds: 30 }],
    ['a two minute race on the moon', { lives: null, score: null, seconds: 120 }],
    ['ragdoll falling down stairs and breaking bones for points', { lives: null, score: null, seconds: null }],
  ] as const)('%s → %j', (sentence, said) => {
    expect(saidNumbers(sentence)).toEqual(said);
  });
});

// Cíle plánu, ne dnešní stav: `it.fails` prochází, dokud report cíl nesplní.
describe('plan P36A targets over all 260 sentences', () => {
  const all = report.summary.all;

  // T4 cíl splnil (2. 10. 2026: 236/260 = 90,8 % – úkol po kolech; mimo pásmo zbývá jen plavba).
  it(`the robot wins in 30–90 s for ≥ ${String(DEPTH_TARGETS.inBandShare * 100)} % of sentences (T4 flipped this)`, () => {
    expect(all.inBandShare).toBeGreaterThanOrEqual(DEPTH_TARGETS.inBandShare);
  });

  // T4 cíl splnil (2. 10. 2026: nečinný prohraje 260/260 – sběr arény má hodiny a pronásledovatele od druhé vlny).
  it(`a player who does nothing loses ≥ ${String(DEPTH_TARGETS.idleLosesShare * 100)} % of games (T4 flipped this)`, () => {
    expect(all.idleLosesShare).toBeGreaterThanOrEqual(DEPTH_TARGETS.idleLosesShare);
  });

  // T2 cíl splnil (2. 10. 2026: 260/260 her začíná se třemi životy) – už ne `it.fails`.
  it(`≥ ${String(DEPTH_TARGETS.livesOver1Share * 100)} % of games start with more than one life (T2 flipped this)`, () => {
    expect(all.livesOver1Share).toBeGreaterThanOrEqual(DEPTH_TARGETS.livesOver1Share);
  });

  // T11 (2. 10. 2026): věta bez slovesa už nehraje vždy běžce; na poptávce je největší Aréna s 59/200 = 29,5 %.
  it('no genre takes more than 35 % of the demand sentences (T11)', () => {
    const demand = report.rows.filter((row) => row.set === 'demand');
    const counts = new Map<string, number>();
    for (const row of demand) counts.set(row.genre.split('.')[0]!, (counts.get(row.genre.split('.')[0]!) ?? 0) + 1);
    expect(Math.max(...counts.values()) / demand.length).toBeLessThanOrEqual(0.35);
  });
});
