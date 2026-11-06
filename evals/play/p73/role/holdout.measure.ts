/**
 * P73A T6: held-out sady P30 (dev 60 + test 200) v rychlé verzi – jen čtení a role, bez robota a bez přiznání.
 * Pro každou větu: drží role z kontrolního seznamu svůj popisek, sedí místo, kreslí hrdinu jeho model (ne model z nouze)
 * a přeloží se arkádový svět. Stejný soubor běží nad `main` i nad větví; srovnání po větách je v `holdout.md`.
 *
 * `npx vitest run --config vitest.measure.mts evals/play/p73/role/holdout.measure.ts` s `HOLDOUT_LABEL=<head|main>`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeAll, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { lookOf } from '@/play/arcade/look';
import { heroChoice } from '@/play/arcade/models';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';

interface Item { readonly item: string; readonly slot: string; readonly match?: readonly string[] }
interface Sentence { readonly id: string; readonly text: string; readonly checklist: readonly Item[] }

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const setOf = (file: string): readonly Sentence[] => (JSON.parse(readFileSync(here(`../../p30/${file}`), 'utf8')) as { sentences: Sentence[] }).sentences;

beforeAll(() => loadRapier());

it('held-out reading and roles', () => {
  const rows = [...setOf('dev.json'), ...setOf('test-200.json')].map((sentence) => {
    const { spec } = draftGameSpecWithMeta(sentence.text, 1);
    const labels = spec.roles.map((role) => role.label.toLowerCase()).join(' | ');
    const place = `${spec.theme.setting} ${lookOf(spec.theme)}`.toLowerCase();
    const hits = (item: Item, text: string) => (item.match ?? [item.item]).some((word) => text.includes(word.toLowerCase()));
    const roles = sentence.checklist.filter((item) => item.slot === 'role' || item.slot === 'any');
    const settings = sentence.checklist.filter((item) => item.slot === 'setting');
    const player = spec.roles.find((role) => role.kind === 'player')?.label ?? '';
    return {
      id: sentence.id,
      roles: roles.length,
      rolesKept: roles.filter((item) => hits(item, labels)).length,
      settings: settings.length,
      settingsKept: settings.filter((item) => hits(item, place)).length,
      heroDrawn: heroChoice(player, spec.genre?.id, spec.control).level !== 'fallback',
      compiles: arcadeWorldOf(spec, 1).ok,
    };
  });
  const sum = (key: 'roles' | 'rolesKept' | 'settings' | 'settingsKept') => rows.reduce((total, row) => total + row[key], 0);
  const summary = {
    sentences: rows.length,
    rolesKept: `${sum('rolesKept')}/${sum('roles')}`,
    settingsKept: `${sum('settingsKept')}/${sum('settings')}`,
    heroDrawn: rows.filter((row) => row.heroDrawn).length,
    compiles: rows.filter((row) => row.compiles).length,
  };
  const label = process.env.HOLDOUT_LABEL ?? 'head';
  writeFileSync(here(`./holdout-${label}.json`), `${JSON.stringify({ summary, rows }, null, 1)}\n`);
  console.log(JSON.stringify({ label, ...summary }));
}, 3_600_000);
