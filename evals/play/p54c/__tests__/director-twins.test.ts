/**
 * P54C T14r1: odpověď režiséra c05 a s02 (T14, gpt-oss-20b) přidá k chytání a krájení role pravidel
 * „bomb“ a „egg“/„fruit“ se stejným druhem a popiskem, jaké má role žánru pruhů. Vazba svědka dřív
 * mezi dvěma kandidáty téhož druhu nevybrala nikoho, bomba neměla jméno a svědek hrozby chyběl
 * („bomb hazard chef“). Test přehraje nahrané odpovědi bez modelu a čeká svědka hrozby ve hře.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { direct } from '@/play/director';
import type { GenerationBranch } from '@/server/pipeline';

const DIR = join(process.cwd(), 'evals', 'play', 'p54c');

interface Recorded { readonly sentence: string; readonly outcome: { readonly ok: true; readonly body: unknown } }
const ANSWERS = (JSON.parse(readFileSync(join(DIR, 'director-answers-t14.json'), 'utf8')) as { answers: Record<string, Recorded> }).answers;

const replay = (recorded: Recorded): GenerationBranch => ({
  id: 'p54c-replay',
  pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
  worstCaseUsd: () => 0,
  generate: () => Promise.resolve({ ok: true, body: recorded.outcome.body, usage: null, provenance: { branch: 'p54c-replay' } }),
});

describe('director answer twins a lane genre role (P54C T14r1)', () => {
  beforeAll(async () => {
    await loadRapier();
  });

  it.each([
    ['c05', 'chef'],
    ['s02', 'ninja'],
  ])('%s keeps the bomb threat witness', async (id, hero) => {
    const recorded = ANSWERS[id]!;
    const game = await direct(recorded.sentence, { branch: replay(recorded), now: Date.now, compact: true, maxRepairRounds: 0, seed: 1 });
    // Odpověď opravdu nese dvojče: role pravidel „bomb“ vedle role žánru `hazard` se stejným popiskem.
    expect(game.source).toBe('authored');
    expect(game.spec.roles.filter((role) => role.kind === 'hazard' && role.label === 'bomb').map((role) => role.id)).toEqual(['hazard', 'bomb']);
    expect((game.unmet ?? []).map((triple) => `${triple.actor} ${triple.verb} ${triple.object ?? '-'}`)).not.toContain(`bomb hazard ${hero}`);
  }, 60_000);
});
