'use client';

/**
 * Počasí a denní doba živé změny (P29D T9) – CSS vrstva nad plátnem.
 *
 * Stav čte z logu živých změn (`visualAt`), ne ze stavu hry: vizuální patch
 * do hashe nesahá a replay ho přehraje z téhož logu. Začíná z `theme` hry –
 * sdílená verze s živými změnami (T10) tam nese svoje počasí. Jasno ve dne
 * nekreslí nic, takže hra bez počasí má stejný DOM jako dřív.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { BufferGeometry, Float32BufferAttribute, type Points, PointsMaterial } from 'three';

import { color } from '@/brand/tokens';
import { HEADER } from '@/play/arcade/contract';
import { visualAt } from '@/play/arcade/live';
import { placeMood } from '@/play/arcade/look';
import type { GameSpecV1 } from '@/play/spec';

import type { ArcadeSession } from './session';

/** Krabice vloček kolem kamery (m): šířka, výška, hloubka před ní. */
const SNOW_BOX = [24, 12, 30] as const;
const FLAKES = 700;
/** Pád vločky (m/s) a boční vlnění. */
const FALL = 1.1;

/** Pseudonáhoda z indexu: vločky leží pokaždé stejně, snímky se dají porovnat. */
const scatter = (i: number, salt: number): number => {
  const h = Math.imul(i ^ Math.imul(salt, 0x9e3779b1), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};

/**
 * Sněžení v zasněžené sadě (P32A T4): body jen v okolí kamery – krabice jde
 * s kamerou a vločka, která z ní vypadne, se vrátí nahoru. Do stavu hry nesahá.
 */
export function Snowfall() {
  const camera = useThree((three) => three.camera);
  const points = useRef<Points>(null);
  const [geometry, material] = useMemo(() => {
    const positions = new Float32Array(FLAKES * 3);
    for (let i = 0; i < FLAKES; i += 1) {
      positions[i * 3] = (scatter(i, 1) - 0.5) * SNOW_BOX[0];
      positions[i * 3 + 1] = scatter(i, 2) * SNOW_BOX[1];
      // Běžec kouká po +z, boční scény (poletování) napříč: krabice sahá i kus za kameru.
      positions[i * 3 + 2] = scatter(i, 3) * SNOW_BOX[2] - 10;
    }
    const built = new BufferGeometry();
    built.setAttribute('position', new Float32BufferAttribute(positions, 3));
    return [built, new PointsMaterial({ color: color.paper, size: 0.07, transparent: true, opacity: 0.9, depthWrite: false })] as const;
  }, []);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  // Druhá vrstva o výšku krabice výš: po přetočení pádu nevznikne prázdný pás.
  const upper = useRef<Points>(null);
  const time = useRef(0);
  useFrame((_, delta) => {
    if (points.current === null || upper.current === null) return;
    time.current += delta;
    // Krabice stojí na kameře, vločky padají v ní: posun je jen čas, pozice vloček se nepřepisují.
    const drop = (time.current * FALL) % SNOW_BOX[1];
    const x = camera.position.x + Math.sin(time.current * 0.7) * 0.3;
    const y = camera.position.y - SNOW_BOX[1] / 2 - drop;
    points.current.position.set(x, y, camera.position.z);
    upper.current.position.set(x, y + SNOW_BOX[1], camera.position.z);
  });
  return (
    <>
      <points ref={points} geometry={geometry} material={material} frustumCulled={false} />
      <points ref={upper} geometry={geometry} material={material} frustumCulled={false} />
    </>
  );
}

export function Weather({ session, theme }: { readonly session: ArcadeSession; readonly theme: GameSpecV1['theme'] }) {
  // Počasí z věty zapíše návrh do `theme` (P54B T11), takže déšť, sníh i mlha jsou vidět od prvního snímku.
  // Starší hra bez něj: bouřka v místě (P46G T5) prší, dokud počasí nezmění spec nebo živá změna.
  const opening = theme.weather === undefined && placeMood(theme.setting, theme.mood) === 'storm' ? { ...theme, weather: 'rain' as const } : theme;
  const start = `${opening.weather ?? 'clear'}|${opening.timeOfDay ?? 'day'}`;
  const key = useSyncExternalStore(
    session.subscribe,
    () => {
      const now = visualAt(session.patches(), session.state()[HEADER.tick] as number, opening);
      return `${now.weather}|${now.timeOfDay}`;
    },
    () => start,
  );
  const [weather, timeOfDay] = key.split('|');
  if (weather === 'clear' && timeOfDay === 'day') return null;
  return <div className="play-weather" data-testid="play-weather" data-weather={weather} data-time={timeOfDay} aria-hidden="true" />;
}
