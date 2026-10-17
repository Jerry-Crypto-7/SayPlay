/**
 * P46F T5: dojde model bosse z noční dávky do hry? Věta → `draftGameSpec` → `arcadeWorldOf`;
 * boss je ve hře, když svět nese pravidlo `boss_beat`/`boss_beat_hit`/`fight_end` s bossem, a kreslí
 * se modelem pronásledovatele (`chaserModel`; `ArenaScene.tsx` část `foe` → `cast.chaser`).
 * Boss finále má jen `GENRE_PACING` arény, souboje, výpravy a střelnice (`pacing-parts.ts`).
 * Zjištění, ne test – nic nehlídá. Výstup JSON do BOSS_REACH_OUT (výchozí D:/caches/p46f/boss-reach.json).
 *   npx vitest run --config vitest.measure.mts evals/play/p46f/boss-reach.measure.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { underlyingRule } from '@/play/arcade/contract';
import { chaserModel } from '@/play/arcade/models';
import { draftGameSpec } from '@/play/draft/draft';

const BOSSES = ['lava golem', 'hydra', 't rex', 'frost giant', 'kaiju', 'manticore', 'necromancer'];
const SHAPES = [
  'Collect the gems in the arena while a {} chases you, you have 3 lives',
  'Run from the {} in the arena and grab the coins',
  'Fight the {} in the arena',
  'Explore the dungeon, find the keys and defeat the {}',
  'Shoot the {} before it reaches you',
  'Top-down arena: eat the dots and avoid the {}, 3 lives',
  'Survive in the arena while the {} hunts you',
];

const catalog = JSON.parse(readFileSync('src/assets/catalog.json', 'utf8')) as { assets: { assetId: string; tags: string[] }[] };
const tagsOf = (id: string): string[] => catalog.assets.find((asset) => asset.assetId === id)?.tags ?? [];
const BOSS_RULES = new Set(['boss_beat', 'boss_beat_hit']);

it('P46F bossové ve hře', () => {
  const rows = BOSSES.flatMap((noun) => SHAPES.map((shape) => {
    const sentence = shape.replace('{}', noun);
    const spec = draftGameSpec(sentence, 1);
    const world = arcadeWorldOf(spec, 1);
    const rules = world.ok ? world.world.rules.map(underlyingRule) : [];
    const boss = rules.some((rule) => BOSS_RULES.has(rule.id) || (rule.id === 'fight_end' && (rule.params as { boss?: number }).boss !== undefined));
    const model = chaserModel(spec);
    const roles = spec.roles.filter((role) => role.kind !== 'player').map((role) => `${role.kind}:${role.label}`).join('; ');
    return { noun, sentence, genre: spec.genre?.id ?? '-', generator: spec.controlParams?.generator ?? spec.control, boss, model, ownModel: tagsOf(model).includes(noun), roles };
  }));
  writeFileSync(process.env.BOSS_REACH_OUT ?? 'D:/caches/p46f/boss-reach.json', `${JSON.stringify(rows, null, 1)}\n`);
});
