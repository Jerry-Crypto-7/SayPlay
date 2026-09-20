/**
 * Dvojník režiséra (P23-C, než dorazí P23-B).
 *
 * Skutečný režisér nechá model napsat `GameSpecV1` z věty. Tady se archetyp
 * pozná z klíčových slov a spec je fixtura toho archetypu s titulkem z věty –
 * okamžitý `draft`, žádné volání modelu. Fixtury jsou **statický import**,
 * ne čtení z disku: na Vercelu je bundle to jediné, co za běhu existuje.
 *
 * Podtržítko v názvu: Next.js soubor nebere jako route.
 */

import type { DirectorResult } from '@/play/contracts';
import type { ArchetypeId } from '@/play/registry';
import { readGameSpec } from '@/play/spec';

import chaseEscape from '@/play/__fixtures__/chase_escape.json';
import checkpointRace from '@/play/__fixtures__/checkpoint_race.json';
import collectExit from '@/play/__fixtures__/collect_exit.json';
import combatLite from '@/play/__fixtures__/combat_lite.json';
import delivery from '@/play/__fixtures__/delivery.json';
import hazardCrossing from '@/play/__fixtures__/hazard_crossing.json';
import survivalTimer from '@/play/__fixtures__/survival_timer.json';
import switchPuzzle from '@/play/__fixtures__/switch_puzzle.json';

const FIXTURES: Readonly<Record<ArchetypeId, { readonly title: string }>> = {
  chase_escape: chaseEscape,
  checkpoint_race: checkpointRace,
  collect_exit: collectExit,
  combat_lite: combatLite,
  delivery,
  hazard_crossing: hazardCrossing,
  survival_timer: survivalTimer,
  switch_puzzle: switchPuzzle,
};

/** První řádek, jehož slovo věta obsahuje, vyhrává; bez shody `collect_exit`. */
const KEYWORDS: readonly (readonly [readonly string[], ArchetypeId])[] = [
  [['chase', 'hunt'], 'chase_escape'],
  [['collect'], 'collect_exit'],
  [['survive'], 'survival_timer'],
  [['race', 'gates'], 'checkpoint_race'],
  [['carry', 'deliver'], 'delivery'],
  [['press', 'switch'], 'switch_puzzle'],
  [['cross', 'lava'], 'hazard_crossing'],
  [['defeat', 'slime'], 'combat_lite'],
];

const TITLE_MAX = 60;

export function archetypeFor(sentence: string): ArchetypeId {
  const lower = sentence.toLowerCase();
  const row = KEYWORDS.find(([words]) => words.some((word) => lower.includes(word)));
  return row === undefined ? 'collect_exit' : row[1];
}

export function getDirector(): (sentence: string) => Promise<DirectorResult> {
  return async (sentence) => {
    const archetype = archetypeFor(sentence);
    const fixture = FIXTURES[archetype];
    const trimmed = sentence.trim();
    const title = trimmed.length === 0 ? fixture.title : trimmed.slice(0, TITLE_MAX);
    const result = readGameSpec({ ...fixture, title });
    if (!result.ok) return { ok: false, reason: 'SPEC_REJECTED', issues: result.issues };
    return { ok: true, spec: result.value, source: 'draft', repairRounds: 0 };
  };
}
