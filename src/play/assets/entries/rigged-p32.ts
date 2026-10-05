/**
 * Animovaní hrdinové vět P32 (P32C T4): CC0 postavy z `src/assets/rigged-p32.json`,
 * které staví `scripts/assets/rigged/build.mjs` ze sad Kenney. Identita, cesta,
 * klipy a licence se berou z JSON jako v `base.ts`; tady se dopisuje třída,
 * rozměr a osa. Stav, na který sada klip nemá (skok a zásah u zvířátek), je
 * `procedural` a pohyb dopočítá `RiggedModel`.
 */

import rigged from '@/assets/rigged-p32.json';

import type { AssetEntry } from '../manifest';

type Extra = Pick<AssetEntry, 'class' | 'dims' | 'forward' | 'fallback' | 'preload'>;

/** Rozměr po stavbě (výška 1,8 m), změřený z GLB 30. 9. 2026 přes `getBounds` z `@gltf-transform/functions`. */
const EXTRA: Readonly<Record<string, Extra>> = {
  'pet-penguin': { class: 'bird', dims: [2.47, 1.8, 1.52], forward: '+z', fallback: '#1f2937', preload: ['runner'] },
  'pet-cat': { class: 'animal', dims: [1.32, 1.8, 1.9], forward: '+z', fallback: '#b45309', preload: ['arena'] },
  'pet-dog': { class: 'animal', dims: [1.43, 1.8, 1.7], forward: '+z', fallback: '#b45309', preload: ['voyage'] },
  'pet-polar-bear': { class: 'animal', dims: [1.5, 1.8, 1.79], forward: '+z', fallback: '#e5e7eb', preload: ['arena'] },
  // P35 T1, změřeno 1. 10. 2026 stejně.
  'pet-bunny': { class: 'animal', dims: [1.12, 1.8, 1.19], forward: '+z', fallback: '#d6d3d1', preload: [] },
  'graveyard-ghost': { class: 'monster', dims: [2.14, 1.8, 1.33], forward: '+z', fallback: '#e5e7eb', preload: ['quest'] },
  'blocky-robot': { class: 'robot', dims: [1.07, 1.8, 0.53], forward: '+z', fallback: '#64748b', preload: ['quest'] },
};

const clipOr = (clip: string | undefined): string => clip ?? 'procedural';

export const RIGGED_P32_ENTRIES: readonly AssetEntry[] = rigged.characters.map((character) => {
  const clips: Partial<Record<string, string>> = character.clips;
  return {
    id: character.id,
    file: character.path,
    identity: character.tags,
    // Nová postava v `rigged-p32.json` bez řádku v `EXTRA` neprojde schématem – test manifestu to ohlásí.
    ...(EXTRA[character.id] as Extra),
    pivot: 'base',
    clips: { idle: clipOr(clips.idle), run: clipOr(clips.run), jump: clipOr(clips.jump), hit: clipOr(clips.hit), die: clipOr(clips.die) },
    license: character.license,
  };
});
