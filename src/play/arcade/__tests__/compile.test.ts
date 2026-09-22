import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { reportFor } from '@/app/api/play/_report';
import { compileGame } from '@/play/compile';
import { readGameSpec, type GameSpecV1 } from '@/play/spec';

import { ARCADE_COMPILER_VERSION } from '../compile';
import runnerFixture from '../__fixtures__/runner.json';

const runner = (): GameSpecV1 => {
  const read = readGameSpec(runnerFixture);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
};

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
