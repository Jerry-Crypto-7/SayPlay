'use client';

/**
 * Spotřebitel sběrnice efektů na plátně (P32-0 T5, vlastní P32A). Zatím bez
 * účinku: částice nekreslí a otřes má nulovou amplitudu – dnešní otřes je CSS
 * třída `play-stage-shake` v `EventFeedback`. Obojí zapne P32A T4.
 *
 * Otřes jde na kameru až po tom, co ji scéna umístila: `Effects` je poslední
 * dítě plátna, takže jeho snímek (`useFrame` se stejnou prioritou) běží po
 * snímku scény. Před snímkem scény se posun z minula vrátí (priorita −1),
 * ať scéna, která kameru nestaví každý snímek, otřes nenasčítá. Záporná
 * priorita R3F kreslení nepřebírá.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Vector3 } from 'three';

import type { ArcadeSession } from '../session';
import { type EffectsBus, createEffectsBus } from './bus';

/** Největší posun kamery při otřesu (m); 0 = bez otřesu, dokud ho nezapne P32A T4. */
const SHAKE_M = 0;

export function Effects({ session }: { readonly session: ArcadeSession }) {
  const camera = useThree((three) => three.camera);
  const bus = useRef<EffectsBus | null>(null);
  const offset = useMemo(() => new Vector3(), []);
  useEffect(() => {
    const created = createEffectsBus(session);
    bus.current = created;
    return () => {
      created.dispose();
      bus.current = null;
    };
  }, [session]);

  useFrame(() => {
    camera.position.sub(offset);
    offset.set(0, 0, 0);
  }, -1);

  useFrame(() => {
    const shake = bus.current?.shake() ?? 0;
    if (shake * SHAKE_M === 0) return;
    // Směr z doznívání (to jde po ticích), ne z náhody: týž záznam třese stejně.
    offset.set(Math.sin(shake * 37), Math.cos(shake * 53), 0).multiplyScalar(shake * SHAKE_M);
    camera.position.add(offset);
    camera.updateMatrixWorld();
  });

  return null;
}
