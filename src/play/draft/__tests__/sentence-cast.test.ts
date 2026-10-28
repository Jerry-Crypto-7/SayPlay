/**
 * P56A T6: hrdina je podmět věty, protivník její předmět, liška jen nouzově. Popisek hrdiny bez modelu
 * (`fallback` = explorer) vypadá v testu popisků jako úspěch, proto se počítá i úroveň volby modelu.
 * Čtení gpt-oss-20b z `evals/play/p56a/readings/` (lokálně, tytéž váhy jako demo); výchozí čísla bez čtení
 * z `evals/play/p56a/baseline.json` (T1).
 */

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { heroChoice } from '@/play/arcade/models';
import { loadRapier } from '@/play/arcade/physics/world';
import { castFor } from '@/play/genre/contract';
import type { Reading } from '@/play/read/schema';

import { EXPECT, gamesOf, loadDeps, namesCast } from '../../../../evals/play/p63/diagnose.mjs';

import { draftGameSpecWithMeta } from '../draft';
import { singular } from '../lexicon';

interface Sentence { readonly id: string; readonly text: string; readonly hero?: string | null; readonly foe?: string | null; readonly item?: string | null; readonly checklist?: readonly { readonly slot: string; readonly match: readonly string[] }[] }

const sentencesOf = (path: string): Sentence[] => (JSON.parse(readFileSync(`evals/play/${path}`, 'utf8')) as { sentences: Sentence[] }).sentences;
const readingsOf = (name: string): ReadonlyMap<string, Reading | null> =>
  new Map((JSON.parse(readFileSync(`evals/play/p56a/readings/${name}.gpt-oss-20b.json`, 'utf8')) as { readings: { id: string; reading: Reading | null }[] }).readings.map((row) => [row.id, row.reading]));
const baseline = JSON.parse(readFileSync('evals/play/p56a/baseline.json', 'utf8')) as { sets: Record<string, { cast: { foxHeroNotSaid: string[] }; panel?: Record<'hero' | 'role', { share: number }> }> };

/** Sady dev s čtením: jméno v `baseline.json`, cesta sady, jméno souboru čtení. */
const DEV = [
  ['audit12', 'p56a/audit-12.json', 'audit-12'],
  ['p43Panel', 'p43/panel.json', 'p43-panel'],
  ['p30Dev', 'p30/dev.json', 'p30-dev'],
  ['p54cDev', 'p54c/dev.json', 'p54c-dev'],
  ['p54cHoldoutOpened', 'p54c/holdout.json', 'p54c-holdout'],
  ['p55HoldoutOpened', 'p55/holdout.json', 'p55-holdout'],
] as const;

function castOf(text: string, reading: Reading | null) {
  const meta = draftGameSpecWithMeta(text, 1, { reading });
  const hero = meta.spec.roles.find((role) => role.kind === 'player')?.label ?? '';
  const foe = meta.genre === null ? null : castFor(meta.genre, 'fight', 'chase_me', 'shoot_at', 'avoid')?.label ?? null;
  return { hero, level: heroChoice(hero, meta.spec.genre?.id, meta.spec.control).level, foe, cast: meta.genre?.cast?.map((item) => item.label) ?? [] };
}

const head = (label: string): string => singular(label.toLowerCase()).split(' ').at(-1) ?? '';
const same = (label: string | null, tag: string): boolean => label !== null && (singular(label.toLowerCase()) === singular(tag) || head(label) === head(tag));
const saysFox = (text: string): boolean => /\bfox/i.test(text);

describe('the hero is the subject, the foe the object, the fox the last resort (P56A T6)', () => {
  const audit = sentencesOf('p56a/audit-12.json');
  const auditReads = readingsOf('audit-12');

  it('casts the audit sentences from their reading: hero ≥ 11/12, its model ≥ 10/12, foe ≥ 90 % of those that have one', () => {
    const rows = audit.map((sentence) => ({ sentence, got: castOf(sentence.text, auditReads.get(sentence.id) ?? null) }));
    // Věta bez hrdiny („you“, „my farm“) projde s hrdinou světa – ne s liškou a ne s protivníkem nebo věcí věty.
    const heroMiss = rows.filter(({ sentence, got }) => sentence.hero != null
      ? !same(got.hero, sentence.hero)
      : got.hero === 'fox' || [sentence.foe, sentence.item].some((tag) => tag != null && same(got.hero, tag)));
    expect(12 - heroMiss.length, heroMiss.map(({ sentence, got }) => `${sentence.id}: ${sentence.hero} -> ${got.hero}`).join('\n')).toBeGreaterThanOrEqual(11);
    const modelMiss = rows.filter(({ got }) => got.level !== 'identity' && got.level !== 'near');
    expect(12 - modelMiss.length, modelMiss.map(({ sentence, got }) => `${sentence.id}: ${got.hero} ${got.level}`).join('\n')).toBeGreaterThanOrEqual(10);
    const foes = rows.filter(({ sentence }) => sentence.foe != null);
    const foeMiss = foes.filter(({ sentence, got }) => !same(got.foe, sentence.foe!));
    expect(foes.length - foeMiss.length, foeMiss.map(({ sentence, got }) => `${sentence.id}: ${sentence.foe} -> ${got.foe}`).join('\n')).toBeGreaterThanOrEqual(Math.ceil(foes.length * 0.9));
  }, 120_000);

  it('fills the P43 panel hero and role slots from the reading at least as well as the keywords', () => {
    const reads = readingsOf('p43-panel');
    const tally = { hero: { hit: 0, of: 0 }, role: { hit: 0, of: 0 } };
    for (const sentence of sentencesOf('p43/panel.json')) {
      const got = castOf(sentence.text, reads.get(sentence.id) ?? null);
      for (const item of sentence.checklist ?? []) {
        if (item.slot !== 'hero' && item.slot !== 'role') continue;
        const where = (item.slot === 'hero' ? got.hero : `${got.hero} ${got.cast.join(' ')}`).toLowerCase();
        tally[item.slot].of += 1;
        if (item.match.some((word) => where.includes(word.toLowerCase()))) tally[item.slot].hit += 1;
      }
    }
    // Podíl jako v `baseline.json` (tři desetinná místa). Hrdina z 0,957 + 0,2 = všech 23. Role 22/30 → 27/30 (+ 0,167):
    // zbylé tři (m06 „passengers“, n03 „sales team“, f08 „rainbow“ jen jako místo) čtení vůbec nejmenuje, „+ 0,2“
    // (28/30) tak dá až ladění promptu v T11.
    const was = baseline.sets.p43Panel!.panel!;
    const share = (t: { hit: number; of: number }) => Math.round((t.hit / t.of) * 1000) / 1000;
    const note = `hero ${tally.hero.hit}/${tally.hero.of}, role ${tally.role.hit}/${tally.role.of} (baseline ${was.hero.share}, ${was.role.share})`;
    expect(share(tally.hero), note).toBeGreaterThanOrEqual(Math.min(1, was.hero.share + 0.2));
    expect(tally.role.hit, note).toBeGreaterThanOrEqual(27);
  }, 120_000);

  it('never casts a fox the sentence does not name when it has a reading', () => {
    const foxes: string[] = [];
    for (const [name, path, reads] of DEV) {
      const readings = readingsOf(reads);
      for (const sentence of sentencesOf(path)) {
        if (!saysFox(sentence.text) && castOf(sentence.text, readings.get(sentence.id) ?? null).hero === 'fox') foxes.push(`${name} ${sentence.id}: ${sentence.text}`);
      }
    }
    expect(foxes).toEqual([]);
  }, 900_000);

  it('casts no more unnamed foxes than the baseline without a reading', () => {
    for (const [name, path] of DEV) {
      const foxes = sentencesOf(path).filter((sentence) => !saysFox(sentence.text) && castOf(sentence.text, null).hero === 'fox').map((sentence) => sentence.id);
      expect(foxes.length, `${name}: ${foxes.join(' ')}`).toBeLessThanOrEqual(baseline.sets[name]!.cast.foxHeroNotSaid.length);
    }
  }, 900_000);
});

describe('the reading game gives every foe the reading names a place (P63 T2)', () => {
  // Uložená čtení astry (`evals/play/p63/readings.astra.json`) cestou serveru (`gamesOf`): ztracený protivník čtení
  // a duch z prostředí místo plamenů byly krok „překlad rolí“ diagnózy T1.
  const set = (JSON.parse(readFileSync('evals/play/p63/read-set.json', 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;
  const readings = JSON.parse(readFileSync('evals/play/p63/readings.astra.json', 'utf8')) as { rows: { id: string; models: Record<string, { reading: Reading | null }> }[] };
  const readingGameOf = async (id: 'h15' | 's002') => {
    const row = set.find((sentence) => sentence.id === id)!;
    const reading = readings.rows.find((entry) => entry.id === id)!.models['astra@openai']!.reading;
    return gamesOf(row.text, reading, await loadDeps()).readingGame!;
  };

  it('h15 sprays the flames with no ghost the sentence never says; s002 collects the keys and dodges the ghosts', async () => {
    const firefighter = await readingGameOf('h15');
    expect(namesCast(firefighter.cast, EXPECT.h15), JSON.stringify(firefighter.cast)).toBe(true);
    expect(firefighter.cast.roles.filter((role) => role.includes('ghost'))).toEqual([]);
    const knight = await readingGameOf('s002');
    expect(namesCast(knight.cast, EXPECT.s002), JSON.stringify(knight.cast)).toBe(true);
  }, 120_000);
});

beforeAll(async () => { await loadRapier(); });
