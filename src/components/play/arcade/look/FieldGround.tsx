'use client';

/**
 * Rovná zem pod hrou bez cesty (P46G T7): síť z `buildFieldGround` – odstíny,
 * skvrny podle povrchu sady, krajnice u hrany hrací plochy a tmavnutí do dálky –
 * místo roviny jedné barvy. Jedna síť, jedno volání kreslení jako dřív.
 */

import { useEffect, useMemo } from 'react';

import type { Look } from '@/play/arcade/look';

import { type Box, buildFieldGround } from './ground';
import { interiorFloorMap } from './interior-floor';
import { UNDER_PANORAMA } from './under-panorama';

export interface FieldGroundProps {
  readonly look: Look;
  /** Kam zem sahá (m); stálý objekt (konstanta nebo `useMemo`). */
  readonly area: Box;
  /** Kraj hrací plochy (`boxEdge`); stálá funkce. Bez něj jen odstíny a skvrny. */
  readonly edge?: (x: number, z: number) => number | null;
  /** Výška roviny (m). */
  readonly y?: number;
  /**
   * Kreslit jako kulisu pod hrou (`UNDER_PANORAMA`, bez zápisu hloubky), jak to
   * dosavadní zem scény dělala; jinak plná zem, která přijímá stín.
   */
  readonly under?: boolean;
}

export function FieldGround({ look, area, edge, y = 0, under = false }: FieldGroundProps) {
  const geometry = useMemo(() => buildFieldGround(look, area, edge), [look, area, edge]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  // Interiér (P62 T6): dlažba povrchu sady jako textura, síť má bílé vrcholy a UV v metrech.
  const map = look.interior === undefined ? null : interiorFloorMap(look.interior.floor);
  return under ? (
    <mesh geometry={geometry} position={[0, y, 0]} renderOrder={UNDER_PANORAMA}>
      <meshStandardMaterial vertexColors map={map} roughness={1} depthWrite={false} />
    </mesh>
  ) : (
    <mesh geometry={geometry} position={[0, y, 0]} receiveShadow>
      <meshStandardMaterial vertexColors map={map} roughness={1} />
    </mesh>
  );
}
