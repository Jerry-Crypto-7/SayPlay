'use client';

/**
 * Okolí světa `room` (P67 T6): podlaha za hranou hrací plochy v barvě země sady prostředí, ať hráč nestojí
 * v prázdnu. Kopuli kreslí obloha scény (`StyleRig`): její shader jede jen s otočením kamery, takže ve VR stojí
 * kolem hlavy v každém měřítku světa – druhá kopule by se pod ní nikdy neukázala.
 *
 * Podlaha leží ve skutečném prostoru (ne v obalu světa) kousek pod zemí scény: kde scéna zem má, kreslí se ta,
 * za její hranou tahle. Mlha scény sem nedosáhne (`<fog>` scény visí na obalu světa, ne na kořeni); do barvy
 * obzoru ji rozpustí jen mlha pódia tratí (P67 T7, `Diorama`), která patří kořeni.
 */

import { useThree } from '@react-three/fiber';
import { useMemo } from 'react';

import { LOOKS, type LookId } from '@/play/arcade/look';

/** Poloměr (m, za mlhou všech sad), dílky kruhu a o kolik pod zemí scény podlaha leží. */
const FLOOR = { radius: 150, segments: 48, below: 0.02 } as const;

/**
 * Sada prostředí hry, do jejíž scény plátno XR kreslí: `ArcadeStage` ji píše do `data-look` a plátno s relací
 * se připojuje do místa scény, která ho právě vlastní (`StageTunnel.attach`). Jen čtení; bez ní výchozí louka.
 */
export function lookIdOf(canvas: Element): LookId {
  const id = canvas.closest('[data-look]')?.getAttribute('data-look') ?? '';
  return Object.hasOwn(LOOKS, id) ? (id as LookId) : 'meadow';
}

/** `game` mění sadu: nová hra se připojí do jiné scény. `floor` = výška podlahy světa (vsedě pod skutečnou, P67 T9). */
export function XrSky({ game, floor }: { readonly game: unknown; readonly floor: number }) {
  const canvas = useThree((three) => three.gl.domElement);
  const lookId = useMemo(() => lookIdOf(canvas), [canvas, game]);
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={floor - FLOOR.below} userData={{ xrSky: lookId }}>
      <circleGeometry args={[FLOOR.radius, FLOOR.segments]} />
      <meshBasicMaterial color={LOOKS[lookId].ground} />
    </mesh>
  );
}
