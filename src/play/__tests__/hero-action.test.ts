/**
 * `heroAction` – co hrdina viditelně dělá (P37-0 T1).
 *
 * Pole je volitelné a **bez výchozí hodnoty**, jako `control`: uložená hra bez
 * něj musí přečíst tentýž tvar a hashovat bajtově stejně jako před jeho
 * zavedením – hashe níž jsou spočítané na kódu bez pole. Jádro ho nečte, jen
 * render, takže se do simulace nesmí dostat ani jako zmínka.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HERO_ACTIONS, readGameSpec } from '../spec';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(process.cwd(), 'src/play/__fixtures__', `${name}.json`), 'utf8')) as Record<string, unknown>;

/** Hash každé fixtury před zavedením pole (P37-0 T1). */
const STORED = { collect_exit: '99c980c9', delivery: 'caab341c', survival_timer: '08e105bd' } as const;

describe('heroAction (P37-0 T1)', () => {
  it.each(Object.entries(STORED))('%s without the field reads the same shape and hash', (name, hash) => {
    const read = readGameSpec(fixture(name));
    if (!read.ok) throw new Error(read.issues.join('; '));
    expect('heroAction' in read.value).toBe(false);
    expect(read.specHash).toBe(hash);
  });

  it('accepts every listed action and moves the hash, rejects one outside the list', () => {
    const base = fixture('collect_exit');
    for (const action of HERO_ACTIONS) {
      const read = readGameSpec({ ...base, heroAction: action });
      if (!read.ok) throw new Error(`${action}: ${read.issues.join('; ')}`);
      expect(read.value.heroAction).toBe(action);
      expect(read.specHash).not.toBe(STORED.collect_exit);
    }
    const unknown = readGameSpec({ ...base, heroAction: 'juggle' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issues.join('\n')).toContain('/heroAction');
  });

  it('the kernel, pieces and rules never mention it', () => {
    const files = (path: string): string[] =>
      statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => files(join(path, name))) : [path];
    const sim = ['kernel.ts', 'pieces', 'rules'].flatMap((part) => files(join(process.cwd(), 'src/play/arcade', part)));
    expect(sim.length).toBeGreaterThan(10);
    expect(sim.filter((path) => readFileSync(path, 'utf8').includes('heroAction'))).toEqual([]);
  });

  it('no simulation file imports the render-only action cues (P43 T4)', () => {
    const files = (path: string): string[] =>
      statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => files(join(path, name))) : [path];
    const sim = files(join(process.cwd(), 'src/play')).filter((path) => /\.tsx?$/.test(path) && !path.includes('__tests__'));
    expect(sim.length).toBeGreaterThan(50);
    expect(sim.filter((path) => readFileSync(path, 'utf8').includes('action-cue'))).toEqual([]);
  });
});
