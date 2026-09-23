import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { reportFor } from '@/app/api/play/_report';
import { compileGame } from '@/play/compile';
import { readGameSpec, type GameSpecV1 } from '@/play/spec';

import { ARCADE_COMPILER_VERSION } from '../compile';
import flapFixture from '../__fixtures__/flap.json';
import platformFixture from '../__fixtures__/platform.json';
import runnerFixture from '../__fixtures__/runner.json';
import shooterFixture from '../__fixtures__/shooter.json';
import throwFixture from '../__fixtures__/throw.json';

const read = (raw: unknown): GameSpecV1 => {
  const result = readGameSpec(raw);
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result.value;
};
const runner = (): GameSpecV1 => read(runnerFixture);

describe('plošinovka a poletování (P25C)', () => {
  it.each([
    ['platform', platformFixture, 'platform_bot'],
    ['flap', flapFixture, 'flap_bot'],
    ['shooter', shooterFixture, 'shooter_bot'],
    ['throw', throwFixture, 'throw_bot'],
  ] as const)('fixtura %s se zkompiluje do arkádového světa a projde ověřením', (control, fixture, bot) => {
    const compiled = compileGame(read(fixture), 1);
    if (!compiled.ok) throw new Error(compiled.issues.join('; '));
    expect(compiled.value.blueprint).toBeNull();
    expect(compiled.value.arcade?.control.id).toBe(control);
    expect(compiled.value.arcade?.bot.id).toBe(bot);
    const report = reportFor(compiled.value);
    expect(report.keypoints.filter((keypoint) => !keypoint.passed)).toEqual([]);
    expect(report.publishEligible).toBe(true);
  });

  it('parametry specu dojdou do generátoru a pravidel', () => {
    const platform = compileGame(read(platformFixture), 1);
    if (!platform.ok) throw new Error(platform.issues.join('; '));
    // checkpoints: true → pád vrací na checkpoint místo prohry.
    expect(platform.value.arcade?.rules.map((rule) => rule.id)).toContain('checkpoint');
    // Výchozí délka je 120 m; úroveň končí na celé desce, proto rozsah.
    expect(platform.value.arcade?.length).toBeGreaterThan(80_000);
    expect(platform.value.arcade?.length).toBeLessThan(100_000);

    const spec = read(flapFixture);
    const flap = compileGame(read({ ...spec, mechanics: [...spec.mechanics, { id: 'health', params: { max: 3 } }] }), 1);
    if (!flap.ok) throw new Error(flap.issues.join('; '));
    expect(flap.value.arcade?.rules[0]?.params).toEqual({ role: 'obstacle', effect: 'damage' });
    expect(flap.value.arcade?.length).toBe(120_000);
  });

  it('parametry jiného ovládání spec odmítne', () => {
    const wrong = readGameSpec({ ...platformFixture, controlParams: { speed: 'fast' } });
    expect(wrong.ok).toBe(false);
    const crossed = readGameSpec({ ...flapFixture, controlParams: { difficulty: 'hard', doubleJump: true } });
    expect(crossed.ok).toBe(false);
    if (!crossed.ok) expect(crossed.issues[0]).toMatch(/^\/controlParams.*\(flap\)$/);
  });
});

describe('control v GameSpec a směrování kompilace', () => {
  it('fixtura běžce se zkompiluje do arkádového světa a projde ověřením', () => {
    const compiled = compileGame(runner(), 1);
    if (!compiled.ok) throw new Error(compiled.issues.join('; '));
    expect(compiled.value.blueprint).toBeNull();
    expect(compiled.value.arcade?.control.id).toBe('runner');
    expect(compiled.value.compilerVersion).toBe(ARCADE_COMPILER_VERSION);
    const report = reportFor(compiled.value);
    expect(report.keypoints.filter((keypoint) => !keypoint.passed)).toEqual([]);
    expect(report.publishEligible).toBe(true);
    expect(report.witness.winsAtTick).toBe(compiled.value.winsAtTick);
  });

  it('stejný spec a seed = stejný svět; jiný seed = jiný', () => {
    const a = compileGame(runner(), 7);
    const b = compileGame(runner(), 7);
    const c = compileGame(runner(), 8);
    if (!a.ok || !b.ok || !c.ok) throw new Error('compile failed');
    expect(a.value.worldHash).toBe(b.value.worldHash);
    expect(a.value.worldHash).not.toBe(c.value.worldHash);
  });

  it('životy a časový limit z mechanik se promítnou do pravidel', () => {
    const spec = runner();
    const spiced = {
      ...spec,
      mechanics: [...spec.mechanics, { id: 'health', params: { max: 3 } }, { id: 'timer', params: { id: 'clock', seconds: 60, onEnd: 'lose' } }],
    };
    const read = readGameSpec(spiced);
    if (!read.ok) throw new Error(read.issues.join('; '));
    const compiled = compileGame(read.value, 1);
    if (!compiled.ok) throw new Error(compiled.issues.join('; '));
    const rules = compiled.value.arcade?.rules.map((rule) => rule.id);
    expect(rules).toEqual(['hit', 'pickup', 'finish', 'out_of_health', 'time_limit']);
    expect(compiled.value.arcade?.rules[0]?.params).toEqual({ role: 'obstacle', effect: 'damage' });
    expect(reportFor(compiled.value).publishEligible).toBe(true);
  });

  // Revize testů: bez tohohle by časový limit mohl nikdy nevystřelit a sada by
  // zůstala zelená – hra s limitem potřebuje jen, aby robot vyhrál.
  it('časový limit kratší než trať robot nestihne – UNWINNABLE', () => {
    const spec = runner();
    const rushed = readGameSpec({
      ...spec,
      controlParams: { ...spec.controlParams, speed: 'slow', lengthM: 500 },
      mechanics: [...spec.mechanics, { id: 'timer', params: { id: 'clock', seconds: 10, onEnd: 'lose' } }],
    });
    if (!rushed.ok) throw new Error(rushed.issues.join('; '));
    const compiled = compileGame(rushed.value, 1);
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) {
      expect(compiled.reason).toBe('UNWINNABLE');
      expect(compiled.issues[0]).toMatch(/lost at tick 601\b/);
    }
  });

  // R3: krátká řídká trať se životy se dala vyhrát bez hraní a publikace spadla
  // na 422 bez dalšího semínka. Teď je to vada rozvržení, na kterou dveře zkusí jiné.
  it('trať, kterou vyhraje i nečinný hráč, je LAYOUT_FAILED, ne hra', () => {
    const spec = runner();
    const easy = readGameSpec({
      ...spec,
      controlParams: { ...spec.controlParams, lengthM: 60, density: 'low' },
      mechanics: [...spec.mechanics, { id: 'health', params: { max: 3 } }],
    });
    if (!easy.ok) throw new Error(easy.issues.join('; '));
    const compiled = compileGame(easy.value, 1);
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.reason).toBe('LAYOUT_FAILED');
  });

  it('parametry ovládání jen u běžce', () => {
    const { control: _control, ...grid } = runner();
    const read = readGameSpec(grid);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.issues[0]).toMatch(/controlParams/);
  });

  it('staré fixtury zůstávají platné a jejich specHash se nepohnul', () => {
    const dir = fileURLToPath(new URL('../../__fixtures__/', import.meta.url));
    const valid = readdirSync(dir).filter((name) => name.endsWith('.json') && !name.startsWith('invalid-'));
    // 8 archetypů + 4 varianty z P25B (plížení, pořadí, bedny, objednávky).
    expect(valid.length).toBe(12);
    for (const name of valid) {
      const raw = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')) as Record<string, unknown>;
      const read = readGameSpec(raw);
      if (!read.ok) throw new Error(`${name}: ${read.issues.join('; ')}`);
      // Nové pole nemá výchozí hodnotu, takže se do přečteného specu nevepíše
      // a `specHash` dnešních her se nepohne (hashe světů pinuje evals/play/compiled).
      expect('control' in read.value, name).toBe(false);
      expect('controlParams' in read.value, name).toBe(false);
    }
  });
});
