'use client';

/**
 * Panel FPS ve VR (P65 T6, `?vrhud=1`) pro ruční bránu T8: kolik snímků relace prošlo za poslední sekundu,
 * nejdelší mezera mezi snímky a medián práce CPU na snímek (`FrameMeter`, měří `KeepXrFrames` v `XrRoot`).
 * Karta kitu jako ostatní panely (`XrPanel`), jen bez tlačítek, menší a pevně v dolním levém rohu pohledu –
 * jede s hlavou, aby byla vidět u každé hry, na stole i v plné velikosti. Čísla se kreslí znovu jednou za sekundu.
 *
 * FPS z emulátoru nejsou FPS Questu: rozhoduje panel a `quest2-fps.json` v brýlích.
 */

import { useFrame } from '@react-three/fiber';
import { useXR } from '@react-three/xr';
import { useMemo, useRef, useState } from 'react';
import { type Group, Quaternion, Vector3 } from 'three';

import type { FrameMeter, FrameReading } from '@/play/xr/quality';

import { type PanelAim, type PanelSpec, XrPanel, layoutOf, useFonts } from './XrPanel';

/** Kde panel visí v osách hlavy (m): vlevo dole (~22° a ~19° od středu), 1,1 m před očima, mimo tabuli s cílem. */
const AT = new Vector3(-0.45, -0.38, -1.1);
/** Menší než karty hry (text ~0,65 úhlové velikosti kitu na 1 m): v rohu pohledu nepřekáží a na Questu 2 se přečte. */
const SCALE = 0.7;
const WIDTH = 300;
const EVERY_MS = 1000;

const specOf = (reading: FrameReading): PanelSpec => ({
  id: 'fps',
  width: WIDTH,
  stats: [
    { value: String(reading.fps), caption: 'fps', label: 'fps' },
    { value: reading.worstMs.toFixed(1), caption: 'worst ms', label: 'worst ms' },
    { value: reading.cpuMs.toFixed(1), caption: 'cpu ms', label: 'cpu ms' },
  ],
});

export function XrFpsHud({ meter, aim }: { readonly meter: FrameMeter; readonly aim: PanelAim }) {
  const group = useRef<Group>(null);
  const space = useXR((xr) => xr.originReferenceSpace);
  const fonts = useFonts();
  const [reading, setReading] = useState<FrameReading>({ fps: 0, worstMs: 0, cpuMs: 0 });
  const shown = useRef(0);
  const at = useMemo(() => ({ turn: new Quaternion(), offset: new Vector3() }), []);
  const layout = useMemo(() => layoutOf(specOf(reading)), [reading, fonts]);

  useFrame((_, __, frame: XRFrame | undefined) => {
    const panel = group.current;
    // Hlava z pózy brýlí v tomto snímku, jako sloupce `XrHud`: kamera XR je v `useFrame` ještě z minulého snímku.
    const viewer = space !== undefined ? frame?.getViewerPose(space) : undefined;
    if (panel !== null && viewer != null) {
      const { position, orientation } = viewer.transform;
      at.turn.set(orientation.x, orientation.y, orientation.z, orientation.w);
      at.offset.copy(AT).applyQuaternion(at.turn);
      panel.position.set(position.x + at.offset.x, position.y + at.offset.y, position.z + at.offset.z);
      panel.quaternion.copy(at.turn);
      panel.scale.setScalar(SCALE);
    }
    const now = performance.now();
    if (now - shown.current < EVERY_MS) return;
    shown.current = now;
    setReading(meter.read(now));
  });

  return (
    <group ref={group}>
      <XrPanel layout={layout} y={0} aim={aim} press={() => undefined} />
    </group>
  );
}
