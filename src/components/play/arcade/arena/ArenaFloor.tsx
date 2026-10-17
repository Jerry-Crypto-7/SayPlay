'use client';

/**
 * Podlaha arény ve stylu B (P32E T5): hrací plocha podle sady – led zamrzlého
 * jezera, dlažba hradu, písek, tráva, skála – prstenec stěn za hranou
 * (`buildArenaFloor`) a kulisy sady za stěnami ze všech čtyř stran.
 *
 * Vnitřek zdobí drobnosti sady (`buildArenaDecor`, P36C T5) – jedna síť bez
 * fyziky, mimo hrdinu a věci na startu (`keep`), rozmístěná ze semínka hry.
 * Řada kulis na straně kamery (−z, popředí) je nejvýš `FOREGROUND_TALLEST`
 * výšek hrdiny (`hero`), vzdálené řady stojí v plné velikosti.
 *
 * Barvy nesou vrcholy sítě z palety sady; tady žádná barva navíc. Podlaha leží
 * v y = 0 na zemi jádra, stěny i kulisy jsou jen vzhled – jádro o nich neví.
 * `half` v metrech.
 *
 * Sada s vegetací (P46G T7) ji má za stěnami: vzadu a po stranách všechny tři
 * vrstvy, na straně kamery (−z) jen nízké drobnosti – kamera kouká pod 40–62°
 * přes ně na hrdinu u přední hrany. Kulisa za mlhou tu není: tak strmá kamera
 * obzor nikdy nevidí, horní kraj obrazu plní vzdálená linie stromů.
 */

import { useEffect, useMemo } from 'react';
import { MeshStandardMaterial } from 'three';

import type { Look } from '@/play/arcade/look';

import { buildArenaDecor, type DecorKeep } from '../look/rig/terrain/arenaDecor';
import { ARENA_WALL_END, buildArenaFloor } from '../look/rig/terrain/arenaFloor';
import { FOREGROUND_TALLEST, Scenery } from '../look/Scenery';
import { VegetationAround } from '../look/Vegetation';
import { LOW_TOWARD_CAMERA } from '../look/vegetation-places';

/** Volný pás vegetace za hranou arény (m): mezera a stěna, pak metr. */
const VEGETATION_CLEAR = ARENA_WALL_END + 1;

export interface ArenaFloorProps {
  readonly look: Look;
  readonly half: number;
  /** Semínko hry: tatáž hra má tutéž výzdobu. */
  readonly seed: number;
  /** Místa těl na startu, kam výzdoba nesmí (m ve scéně). */
  readonly keep: readonly DecorKeep[];
  /** Výška nakresleného hrdiny (m) – strop kulis v popředí. */
  readonly hero: number;
}

export function ArenaFloor({ look, half, seed, keep, hero }: ArenaFloorProps) {
  const arena = useMemo(() => buildArenaFloor({ look, half }), [look, half]);
  const decor = useMemo(() => buildArenaDecor({ look, half, seed, keep }), [look, half, seed, keep]);
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
  useEffect(() => () => decor.dispose(), [decor]);
  useEffect(() => () => ground.dispose(), [ground]);
  useEffect(() => () => walls.dispose(), [walls]);
  const box = useMemo(() => ({ x0: -half, x1: half, z0: -half, z1: half }), [half]);
  return (
    <>
      {/* Stín jen přijímá: rovná plocha by si vlastní stín kreslila jako akné. */}
      <mesh geometry={arena.floor} material={ground} receiveShadow userData={{ rigShadow: 'receive', terrain: 'arena' }} />
      {/* Výzdoba stín nevrhá: stínový průchod by stál další volání za kamínky, které nikdo nehledá. */}
      <mesh geometry={decor} material={walls} receiveShadow userData={{ rigShadow: 'receive', terrain: 'arena-decor' }} />
      <mesh geometry={arena.walls} material={walls} userData={{ terrain: 'arena-walls' }} />
      {look.flora !== undefined && <VegetationAround flora={look.flora} seed={seed} box={box} clear={VEGETATION_CLEAR} layers={LOW_TOWARD_CAMERA} />}
      {[0, Math.PI / 2].map((turn) => (
        <group key={turn} rotation={[0, turn, 0]}>
          {/* Otočená skupina staví stranu +x na −z scény – na stranu kamery. */}
          <Scenery look={look} layout="sides" inner={arena.sceneryInner} from={-arena.sceneryInner} to={arena.sceneryInner} cap={look.terrain?.cap} tallest={turn === 0 ? undefined : { side: 1, height: FOREGROUND_TALLEST * hero }} vegetation />
        </group>
      ))}
    </>
  );
}
