/**
 * Tabulka sloves P44C (T5) se staví jen offline a nikdo ji nečte očima. Ruční úprava `verbs.json`
 * nebo změna kotev bez přestavby by tiše změnila hry – proto se hash tabulky i jejích vstupů
 * porovnává s manifestem, který zapsala stavba (`node scripts/vocab/build.mjs`).
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HERO_ACTIONS } from '../../hero-action';
import { ACTIONS, MOVES, OBJECTIVES } from '../../intent/contract';

const VERBS = 'src/play/vocab/verbs.json';

/** SHA-256 nad LF bajty – stejně jako stavba, ať je checkout CRLF nebo LF. */
const lfSha = (path: string): string => createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

const manifest = JSON.parse(readFileSync('src/play/vocab/manifest.json', 'utf8')) as {
  inputs: { oewn: { sha256: string }; anchors: { sha256: string }; config: { sha256: string }; embed: { model: string; revision: string } };
  outputs: { verbs: { sha256: string } };
};
const table = JSON.parse(readFileSync(VERBS, 'utf8')) as {
  sentinel: string;
  targets: string[];
  verbs: Record<string, [number, number, number]>;
};
const config = JSON.parse(readFileSync('scripts/vocab/config.json', 'utf8')) as {
  oewn: { sha256: string };
  embed: { model: string; revision: string };
};

const VALID_TARGETS = new Set([
  ...MOVES.map((id) => `move:${id}`),
  ...ACTIONS.map((id) => `action:${id}`),
  ...OBJECTIVES.map((id) => `objective:${id}`),
  ...HERO_ACTIONS.filter((id) => id !== 'none').map((id) => `hero:${id}`),
]);

describe('verb table integrity', () => {
  it('matches the manifest written by the build', () => {
    expect(lfSha(VERBS)).toBe(manifest.outputs.verbs.sha256);
  });

  it('was built from the current anchors and config', () => {
    expect(lfSha('src/play/vocab/anchors.ts')).toBe(manifest.inputs.anchors.sha256);
    expect(lfSha('scripts/vocab/config.json')).toBe(manifest.inputs.config.sha256);
    expect(manifest.inputs.oewn.sha256).toBe(config.oewn.sha256);
    expect(manifest.inputs.embed).toEqual(config.embed);
  });

  it('has the schema the lookup reads', () => {
    expect(table.sentinel).toBe('p44c-vocab-verbs');
    for (const target of table.targets) expect(VALID_TARGETS, target).toContain(target);
    const entries = Object.entries(table.verbs);
    // Metoda A @ 0,4 dala 702 sloves; propad pod 500 znamená rozbitou stavbu, ne přísnější kotvy.
    expect(entries.length).toBeGreaterThan(500);
    for (const [lemma, [axis, hero, score]] of entries) {
      expect(lemma).toMatch(/^[a-z]+$/);
      expect(axis !== -1 || hero !== -1, lemma).toBe(true);
      if (axis !== -1) expect(table.targets[axis], lemma).not.toMatch(/^hero:/);
      if (hero !== -1) expect(table.targets[hero], lemma).toMatch(/^hero:/);
      expect(Number.isInteger(score) && score > 0 && score <= 1000, lemma).toBe(true);
    }
  });

  it('carries the probe verbs the method was chosen on', () => {
    const target = (lemma: string) => table.targets[table.verbs[lemma]?.[0] ?? -1];
    expect(target('stab')).toBe('action:fight');
    expect(target('sprint')).toBe('move:run');
    expect(target('lug')).toBe('action:deliver');
    expect(table.verbs.explain).toBeUndefined();
  });

  it('stays within the 160 KB server budget', () => {
    expect(statSync(VERBS).size).toBeLessThanOrEqual(160 * 1024);
  });
});
