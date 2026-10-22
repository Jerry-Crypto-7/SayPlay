'use client';

/**
 * Pruhy žánrů v pruzích z povrchu sady (P56B T11) místo holých zelených desek: každý pruh je pás cesty
 * (`roadGeometry`, jako dráha běžce) – hlína, prkna, dlažba, písek, sníh nebo asfalt s lemem po krajích
 * a spárami prken –, sousední pruhy se liší jen jasem. `light` barvy zesvětlí k papíru. Deska chytání
 * drží světlou výplň P55 (`fill`): povrch sady by kontrast ovoce proti ní snížil (T11, README).
 * Pět pruhů jsou čtyři sítě: sudé, liché, lemy a spáry.
 */

import { useEffect, useMemo } from 'react';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { color } from '@/brand/tokens';
import { UNIT } from '@/play/arcade/contract';
import { type Look, SURFACES } from '@/play/arcade/look';
import { LANES, laneX } from '@/play/arcade/pieces/lanes';

import { mix } from '../../look/ground';
import { roadGeometry } from '../../look/road-strip';

/** Šířka pásu pruhu (m): mezi pruhy prosvítá zem. */
const STRIP_M = (LANES.width / UNIT) * 0.94;
/** Lichý pruh je o tolik tmavší (směs k inkoustu v lineárním světle). */
const ODD_SHADE = 0.16;

/** Barvy pruhů sady: sudý, lichý, lem a spáry; `light` = podíl papíru. */
export function laneColors(look: Look, light = 0): { readonly even: string; readonly odd: string; readonly edge: string; readonly seam: string } {
  const surface = SURFACES[look.surface];
  const even = mix(surface.color, color.paper, light);
  return {
    even,
    odd: mix(even, color.ink, ODD_SHADE),
    edge: mix(surface.edge, color.paper, light),
    seam: mix('marks' in surface ? surface.marks.color : surface.edge, color.paper, light),
  };
}

/** `fill` = vlastní výplň sudých a lichých pruhů (deska chytání); povrch sady pak dává jen lem a spáry. */
export function LaneStrips({ look, z0, z1, light = 0, fill }: { readonly look: Look; readonly z0: number; readonly z1: number; readonly light?: number; readonly fill?: readonly [even: string, odd: string] }) {
  const surface = SURFACES[look.surface];
  const built = useMemo(() => {
    const lanes = Array.from({ length: LANES.count }, (_, lane) => roadGeometry([{ near: z0, far: z1, center: -laneX(lane) / UNIT, width: STRIP_M }], surface)!);
    const merged = {
      even: mergeGeometries(lanes.filter((_, lane) => lane % 2 === 0).map((road) => road.surface)),
      odd: mergeGeometries(lanes.filter((_, lane) => lane % 2 === 1).map((road) => road.surface)),
      edges: mergeGeometries(lanes.map((road) => road.edges)),
      // Spáry prken ano, středová čára asfaltu ne: pruh není silnice (jako u běžce).
      seams: 'marks' in surface && surface.marks.kind === 'seams' ? mergeGeometries(lanes.map((road) => road.marks!)) : null,
    };
    for (const road of lanes) for (const geometry of [road.surface, road.edges, road.marks]) geometry?.dispose();
    return merged;
  }, [surface, z0, z1]);
  useEffect(() => () => { for (const geometry of Object.values(built)) geometry?.dispose(); }, [built]);
  const tones = useMemo(() => ({ ...laneColors(look, light), ...(fill === undefined ? {} : { even: fill[0], odd: fill[1] }) }), [look, light, fill]);
  return (
    <>
      {/* Pásy leží na zemi: stín jen přijímají (P54B T15d). */}
      <mesh geometry={built.even} receiveShadow userData={{ rigShadow: 'receive' }}>
        <meshStandardMaterial color={tones.even} roughness={0.95} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
      </mesh>
      <mesh geometry={built.odd} receiveShadow userData={{ rigShadow: 'receive' }}>
        <meshStandardMaterial color={tones.odd} roughness={0.95} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
      </mesh>
      <mesh geometry={built.edges} receiveShadow userData={{ rigShadow: 'receive' }}>
        <meshStandardMaterial color={tones.edge} roughness={0.95} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
      </mesh>
      {built.seams !== null && (
        <mesh geometry={built.seams} receiveShadow userData={{ rigShadow: 'receive' }}>
          <meshStandardMaterial color={tones.seam} roughness={0.95} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
        </mesh>
      )}
    </>
  );
}
