/**
 * Základní položky manifestu (P32-0 T6): 16 rigovaných CC0 postav z
 * `src/assets/rigged.json` (P26B) a tučňák ze složky her. Identita, cesta,
 * klipy a licence se berou z `rigged.json`, ať se manifest s generátorem
 * (`scripts/assets/rigged/build.mjs`) nerozejde; tady se dopisuje jen to,
 * co `rigged.json` neříká.
 */

import rigged from '@/assets/rigged.json';

import type { AssetEntry } from '../manifest';

type Extra = Pick<AssetEntry, 'class' | 'dims' | 'fallback' | 'preload'>;

/** Rozměr skinovaného těla v klidové póze (T-póza, ruce do šířky), změřený z GLB 29. 9. 2026. */
const SKELETON: AssetEntry['dims'] = [1.94, 2.17, 0.91];

const RIGGED_EXTRA: Readonly<Record<string, Extra>> = {
  knight: { class: 'humanoid', dims: [1.94, 2.31, 1.02], fallback: '#9ca3af', preload: ['arena', 'quest'] },
  barbarian: { class: 'humanoid', dims: [1.94, 2.19, 0.99], fallback: '#b45309', preload: ['arena'] },
  mage: { class: 'humanoid', dims: [1.94, 2.2, 1.27], fallback: '#2563eb', preload: ['quest', 'voyage'] },
  rogue: { class: 'humanoid', dims: [1.94, 2.19, 1.02], fallback: '#374151', preload: ['arena', 'voyage'] },
  'rogue-hooded': { class: 'humanoid', dims: [1.94, 2.25, 1.16], fallback: '#15803d', preload: ['arena'] },
  'skeleton-warrior': { class: 'monster', dims: SKELETON, fallback: '#e5e7eb', preload: ['arena'] },
  'skeleton-minion': { class: 'monster', dims: SKELETON, fallback: '#e5e7eb', preload: ['arena'] },
  'skeleton-mage': { class: 'monster', dims: SKELETON, fallback: '#e5e7eb', preload: ['arena'] },
  'skeleton-rogue': { class: 'monster', dims: SKELETON, fallback: '#e5e7eb', preload: ['arena'] },
  'boy-a': { class: 'humanoid', dims: [0.77, 0.67, 0.34], fallback: '#0ea5e9', preload: ['runner', 'platformer'] },
  'boy-b': { class: 'humanoid', dims: [0.77, 0.66, 0.39], fallback: '#0ea5e9', preload: ['runner', 'platformer'] },
  'boy-c': { class: 'humanoid', dims: [0.77, 0.79, 0.46], fallback: '#0ea5e9', preload: ['runner', 'platformer'] },
  'girl-a': { class: 'humanoid', dims: [1.1, 0.78, 0.5], fallback: '#f97316', preload: ['runner', 'platformer'] },
  'girl-b': { class: 'humanoid', dims: [0.77, 0.72, 0.42], fallback: '#f97316', preload: ['runner', 'platformer'] },
  'girl-c': { class: 'humanoid', dims: [0.77, 0.78, 0.5], fallback: '#f97316', preload: ['runner', 'platformer'] },
};

const RIGGED_ENTRIES: readonly AssetEntry[] = rigged.characters.map((character) => ({
  id: character.id,
  file: character.path,
  identity: character.tags,
  // Nová postava v `rigged.json` bez řádku výš neprojde schématem – test manifestu to ohlásí.
  ...(RIGGED_EXTRA[character.id] as Extra),
  pivot: 'base',
  forward: '+z',
  clips: {
    idle: character.clips.idle,
    // Chůze a výhra (P54B T5) jen tam, kde je GLB má; jinak `RiggedModel` hraje běh, resp. klid.
    ...(character.clips.walk === undefined ? {} : { walk: character.clips.walk }),
    run: character.clips.run,
    jump: character.clips.jump,
    hit: character.clips.hit ?? 'procedural',
    die: character.clips.die,
    ...(character.clips.win === undefined ? {} : { win: character.clips.win }),
  },
  license: character.license,
}));

/** Tučňák z `scripts/assets/blender/game_models.py`: statický model, pohyb dopočítá kód. */
const PENGUIN: AssetEntry = {
  id: 'penguin',
  file: '/assets/worldstream/game/penguin-lod0.glb',
  identity: ['penguin'],
  class: 'bird',
  dims: [0.64, 0.92, 0.5],
  pivot: 'base',
  forward: '+z',
  clips: { idle: 'procedural', run: 'procedural', jump: 'procedural', hit: 'procedural', die: 'procedural' },
  fallback: '#1f2937',
  license: 'LicenseRef-Worldsmith-Original',
  preload: ['runner'],
};

export const BASE_ENTRIES: readonly AssetEntry[] = [PENGUIN, ...RIGGED_ENTRIES];
