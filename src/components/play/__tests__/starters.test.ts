import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_SENTENCE_CHARS } from '@/app/api/play/_publish';
import { ARCHETYPES } from '@/play/registry';
import { REMIX_CHIP_LABELS as CHIP_LABELS, REMIX_CHIPS as CHIPS } from '@/play/director/remix';
import { draftGameSpec, draftGameSpecWithMeta } from '@/play/draft';

import {
  BUILD_FAILED,
  BUILD_STEPS,
  CAN_YOU_BEAT_IT,
  CHANGE_ONE_THING,
  COPY_LINK,
  DARE_A_FRIEND,
  DARE_BADGE,
  DARE_SHORT,
  FULL_READY,
  HERO,
  IDEA_LIMIT,
  IDEAS,
  LINK_COPIED,
  NOT_SENT,
  OFFLINE,
  PLACEHOLDER,
  PLAY_FULL,
  POST_RUN_CHIPS,
  PROMPT_LABEL,
  QUICK_VERSION,
  QUICK_VERSION_REST,
  REMIX_IT,
  REMIX_LABEL,
  REMIX_PLACEHOLDER,
  SAVE_VIDEO,
  SENTENCE_LIMIT,
  SHARE_TITLE,
  SO_CLOSE,
  STARTERS,
  SUBHEAD,
  VIDEO_AFTER_RUN,
  YOU_DID_IT,
} from '../starters';

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

  // P32B T2: návrh nové hry vybírá žánr, archetyp mřížky už ne – karta musí přistát v žánru, který slibuje její štítek.
  it('věta karty přistane v návrhu ze slov v žánru svého štítku', () => {
    const promised: Readonly<Record<string, string>> = {
      Chase: 'arena.escape',
      Collect: 'arena.collect',
      Survive: 'arena.escape',
      Race: 'voyage.race',
      Deliver: 'quest.spatial',
      Puzzle: 'quest.spatial',
      Cross: 'platformer.default',
      Fight: 'arena.fight',
    };
    for (const starter of STARTERS) {
      const meta = draftGameSpecWithMeta(starter.sentence);
      expect(meta.fellBack, starter.label).toBe(false);
      expect(`${meta.genre?.genre}.${meta.genre?.mode}`, starter.label).toBe(promised[starter.label]);
      // „Cross floating islands“: sloveso karty není hrdina.
      expect(meta.genre?.hero, starter.label).not.toBe(starter.label.toLowerCase());
    }
  });

  it('věty jsou zlaté prompty z balíčku (hazard_platforming → hazard_crossing)', () => {
    const rows = new Map(GOLDEN.split('\n').slice(1).map((row) => row.split(',')).map(([bucket, prompt]) => [bucket, prompt]));
    for (const starter of STARTERS) {
      const bucket = starter.archetype === 'hazard_crossing' ? 'hazard_platforming' : starter.archetype;
      expect(starter.sentence, starter.archetype).toBe(rows.get(bucket));
    }
  });

  // P34: strop pole je 140 z kitu; dveře serveru (veřejné API mimo P34) snesou víc, nikdy míň.
  it('žádná věta nepřesáhne strop pole 140 znaků a dveře serveru snesou celé pole', () => {
    expect(SENTENCE_LIMIT).toBe(140);
    expect(SENTENCE_LIMIT).toBeLessThanOrEqual(MAX_SENTENCE_CHARS);
    for (const starter of STARTERS) expect(starter.sentence.length).toBeLessThanOrEqual(SENTENCE_LIMIT);
  });
});

describe('karty nápadů (P34 T3)', () => {
  it('jsou čtyři, každá nejvýš 45 znaků a doslova z balíčku', () => {
    expect(IDEAS).toHaveLength(4);
    for (const idea of IDEAS) expect(idea.sentence.length, idea.sentence).toBeLessThanOrEqual(IDEA_LIMIT);
    expect(IDEA_LIMIT).toBe(45);
    expect(IDEAS.map((idea) => idea.sentence)).toEqual(copyLine('Ideas').replace(/\.$/, '').split(' / '));
  });

  it('věta karty přistane v návrhu ze slov na archetypu, který karta slibuje', () => {
    expect(new Set(IDEAS.map((idea) => idea.archetype)).size).toBe(IDEAS.length);
    for (const idea of IDEAS) {
      const meta = draftGameSpecWithMeta(idea.sentence);
      // P32B T5b: věta hraje žánr. Skutečná Aréna nemá cíl „dojdi“ (`chase_escape`): honička je útěk
      // Arény – přežít, nebo sbírat s pronásledovatelem. Donáška („carry … to“) je Úkol se slovesem
      // „deliver“ (`switch_puzzle`). Archetyp karty je tu jen klíč a testid.
      if (idea.archetype === 'chase_escape') expect(meta.genre, idea.sentence).toMatchObject({ genre: 'arena', mode: 'escape' });
      else if (idea.archetype === 'delivery') expect(meta.genre, idea.sentence).toMatchObject({ genre: 'quest', cast: expect.arrayContaining([expect.objectContaining({ verb: 'deliver' })]) });
      else expect(draftGameSpec(idea.sentence).archetype, idea.sentence).toBe(idea.archetype);
    }
  });
});

describe('měď z PRODUCT_COPY.md', () => {
  it('hero, subhead, popisek a placeholder jsou doslova z balíčku', () => {
    expect(HERO).toBe(copyLine('Hero'));
    expect(SUBHEAD).toBe(copyLine('Subhead'));
    expect(PROMPT_LABEL).toBe(copyLine('Label'));
    expect(PLACEHOLDER).toBe(copyLine('Placeholder'));
  });

  // P34 T6: věty výsledku a sdílení mluví kitem ve větném tvaru – karta je už nepřepisuje.
  it('po dohrání: nadpisy, list, sdílení a čipy doslova z balíčku, čipy v pořadí a se jmény z remixu', () => {
    expect([YOU_DID_IT, SO_CLOSE]).toEqual(copyLine('Result').split(' / '));
    expect(CHANGE_ONE_THING).toBe(copyLine('Post-run'));
    expect([DARE_A_FRIEND, DARE_SHORT, LINK_COPIED]).toEqual(copyLine('Share').split(' / '));
    expect(POST_RUN_CHIPS.map((entry) => entry.label)).toEqual(copyLine('Chips').replace(/.$/, '').split(' / '));
    expect(POST_RUN_CHIPS.map((entry) => entry.chip)).toEqual([...CHIPS]);
    for (const entry of POST_RUN_CHIPS) expect(entry.label).toBe(CHIP_LABELS[entry.chip]);
  });

  // P34 T7: list „Change one thing“, list sdílení v HUD a karta výzvy (náhled odkazu).
  it('remix, list sdílení a karta výzvy jsou doslova z balíčku', () => {
    expect([REMIX_LABEL, REMIX_PLACEHOLDER, REMIX_IT]).toEqual(copyLine('Remix').split(' / '));
    expect([SHARE_TITLE, COPY_LINK, SAVE_VIDEO, VIDEO_AFTER_RUN]).toEqual(copyLine('Share sheet').split(' / '));
    expect([CAN_YOU_BEAT_IT, DARE_BADGE.survive, DARE_BADGE.hurry, DARE_BADGE.none, DARE_BADGE.dare]).toEqual(copyLine('Dare card').split(' / '));
  });

  it('stavový řádek jde přes čtyři stavy v pořadí balíčku', () => {
    expect(BUILD_STEPS).toEqual(copyLine('States').split('->').map((step) => step.trim().replace(/\.$/, '')));
  });

  // P34 T4: pilulka, toast AI verze a chyby dveří mluví kitem (`11-voice-copy.md`).
  it('pilulka a toast AI verze a chyby dveří jsou doslova z balíčku', () => {
    expect([QUICK_VERSION + QUICK_VERSION_REST, FULL_READY, PLAY_FULL]).toEqual(copyLine('AI version').split(' / ').slice(0, 3));
    expect([BUILD_FAILED, OFFLINE, NOT_SENT]).toEqual(copyLine('Errors').split(' / '));
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
