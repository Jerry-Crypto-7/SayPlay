import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_SENTENCE_CHARS } from '@/app/api/play/_publish';
import { ARCHETYPES } from '@/play/registry';
import { REMIX_CHIP_LABELS as CHIP_LABELS, REMIX_CHIPS as CHIPS } from '@/play/director/remix';
import { draftGameSpec } from '@/play/draft';

import { BUILD_STEPS, CHALLENGE_A_FRIEND, CHANGE_ONE_THING, HERO, PLACEHOLDER, POST_RUN_CHIPS, SENTENCE_LIMIT, STARTERS, SUBHEAD } from '../starters';

/**
 * Stránka `/play` vypadá hotově i s kartou, která pošle větu na cizí archetyp,
 * nebo s mědí, která se od balíčku odchýlí o slovo. Oko to nepozná; tohle ano.
 */

const ROOT = process.cwd();
const COPY = readFileSync(join(ROOT, 'docs/play/pack/PRODUCT_COPY.md'), 'utf-8');
const GOLDEN = readFileSync(join(ROOT, 'docs/play/pack/golden_prompts.csv'), 'utf-8');
// Od P34 nese `play.css` jen `var(--sp-…)` (hex zakazuje `brand-guard.test.ts`); hexy palety jsou v tokenech kitu.
const CSS = ['src/app/play/play.css', 'src/brand/tokens.css'].map((file) => readFileSync(join(ROOT, file), 'utf-8')).join('\n');

function copyLine(label: string): string {
  const line = COPY.split('\n').find((row) => row.startsWith(`${label}:`));
  expect(line, `PRODUCT_COPY.md nemá řádek ${label}`).toBeDefined();
  return (line as string).slice(label.length + 1).trim().replace(/^\*\*|\*\*$/g, '');
}

describe('startovní karty', () => {
  it('je jich osm, každý archetyp právě jednou', () => {
    expect(STARTERS.map((starter) => starter.archetype).sort()).toEqual(Object.keys(ARCHETYPES).sort());
  });

  it('věta karty přistane v návrhu ze slov na svém archetypu', () => {
    for (const starter of STARTERS) expect(draftGameSpec(starter.sentence).archetype, starter.archetype).toBe(starter.archetype);
  });

  it('věty jsou zlaté prompty z balíčku (hazard_platforming → hazard_crossing)', () => {
    const rows = new Map(GOLDEN.split('\n').slice(1).map((row) => row.split(',')).map(([bucket, prompt]) => [bucket, prompt]));
    for (const starter of STARTERS) {
      const bucket = starter.archetype === 'hazard_crossing' ? 'hazard_platforming' : starter.archetype;
      expect(starter.sentence, starter.archetype).toBe(rows.get(bucket));
    }
  });

  it('žádná věta nepřesáhne strop dveří a strop je týž jako na serveru', () => {
    expect(SENTENCE_LIMIT).toBe(MAX_SENTENCE_CHARS);
    for (const starter of STARTERS) expect(starter.sentence.length).toBeLessThanOrEqual(SENTENCE_LIMIT);
  });
});

describe('měď z PRODUCT_COPY.md', () => {
  it('hero, subhead a placeholder jsou doslova z balíčku', () => {
    expect(HERO).toBe(copyLine('Hero'));
    expect(SUBHEAD).toBe(copyLine('Subhead'));
    expect(PLACEHOLDER).toBe(copyLine('Placeholder'));
  });

  it('po dohrání: nadpis, sdílení a čipy doslova z balíčku, čipy v pořadí a se jmény z remixu', () => {
    expect(CHANGE_ONE_THING).toBe(copyLine('Post-run'));
    expect(CHALLENGE_A_FRIEND).toBe(copyLine('Share'));
    expect(POST_RUN_CHIPS.map((entry) => entry.label)).toEqual(copyLine('Chips').replace(/.$/, '').split(' / '));
    expect(POST_RUN_CHIPS.map((entry) => entry.chip)).toEqual([...CHIPS]);
    for (const entry of POST_RUN_CHIPS) expect(entry.label).toBe(CHIP_LABELS[entry.chip]);
  });

  it('stavový řádek jde přes čtyři stavy v pořadí balíčku', () => {
    expect(BUILD_STEPS).toEqual(copyLine('States').split('->').map((step) => step.trim().replace(/\.$/, '')));
  });
});

describe('paleta /play', () => {
  it('nemá fialovou – ani jménem, ani hexem z pásma 250–320°', () => {
    expect(CSS).not.toMatch(/#7c3aed|#8b5cf6|#a855f7|#9333ea|purple|violet|indigo|fuchsia/i);
    for (const hex of CSS.match(/#[0-9a-f]{6}\b/gi) ?? []) {
      const hue = hueOf(hex);
      expect(hue === null || hue < 250 || hue > 320, `${hex} je fialová (${String(hue)}°)`).toBe(true);
    }
  });
});

/** Odstín 0–360 ze sRGB hexu; šedé vrací `null` (týž výpočet jako `src/app/__tests__/theme.test.ts`). */
function hueOf(hex: string): number | null {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (span === 0) return null;
  let hue: number;
  if (max === r) hue = ((g - b) / span) % 6;
  else if (max === g) hue = (b - r) / span + 2;
  else hue = (r - g) / span + 4;
  return (((hue * 60) % 360) + 360) % 360;
}
