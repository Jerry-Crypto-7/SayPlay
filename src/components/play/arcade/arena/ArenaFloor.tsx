'use client';

/**
 * Podlaha arény ve stylu B (P32E T5): hrací plocha podle sady – led zamrzlého
 * jezera, dlažba hradu, písek, tráva, skála – prstenec stěn za hranou
 * (`buildArenaFloor`) a kulisy sady za stěnami ze všech čtyř stran.
 *
 * Barvy nesou vrcholy sítě z palety sady; tady žádná barva navíc. Podlaha leží
 * v y = 0 na zemi jádra, stěny i kulisy jsou jen vzhled – jádro o nich neví.
 * `half` v metrech.
 */

import { useEffect, useMemo } from 'react';
import { MeshStandardMaterial } from 'three';

import type { Look } from '@/play/arcade/look';

import { buildArenaFloor } from '../look/rig/terrain/arenaFloor';
import { Scenery } from '../look/Scenery';

export function ArenaFloor({ look, half }: { readonly look: Look; readonly half: number }) {
  const arena = useMemo(() => buildArenaFloor({ look, half }), [look, half]);
  // Led se leskne, dlažba, písek a tráva ne.
  const ground = useMemo(() => new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: look.cover === 'snow' ? 0.45 : 0.9 }), [look.cover]);
  const walls = useMemo(() => new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 }), []);
  useEffect(
    () => () => {
      arena.floor.dispose();
      arena.walls.dispose();
    },
    [arena],
  );
  useEffect(() => () => ground.dispose(), [ground]);
  useEffect(() => () => walls.dispose(), [walls]);
  return (
    <>
      {/* Stín jen přijímá: rovná plocha by si vlastní stín kreslila jako akné. */}
      <mesh geometry={arena.floor} material={ground} receiveShadow userData={{ rigShadow: 'receive', terrain: 'arena' }} />
      <mesh geometry={arena.walls} material={walls} userData={{ terrain: 'arena-walls' }} />
      {[0, Math.PI / 2].map((turn) => (
        <group key={turn} rotation={[0, turn, 0]}>
          <Scenery look={look} layout="sides" inner={arena.sceneryInner} from={-arena.sceneryInner} to={arena.sceneryInner} cap={look.terrain?.cap} />
        </group>
      ))}
    </>
  );
}
