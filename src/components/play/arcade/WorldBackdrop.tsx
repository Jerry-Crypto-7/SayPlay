'use client';

/**
 * Výchozí podklad sdíleného `World` (P26 T11, vyčleněno v P46G T7): poletování,
 * střelnice a hod; běžec a plošinovka mají vlastní (`RunnerWorld`, `PlatformWorld`)
 * a větve tady zůstávají jen pro svět bez obalu. Jen vzhled: jádro o podkladu neví.
 *
 * P46G T7: střelnice a hod dostaly zem s odstíny a skvrnami (`buildFieldGround`),
 * vegetaci sady mimo hrací plochu a kulisu za mlhou; poletování jen kulisu.
 */

import { UNIT } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { LOOK_STYLE } from '@/play/arcade/look/style';
import { FLAP } from '@/play/arcade/pieces/flap';
import { PLATFORM } from '@/play/arcade/pieces/platform';
import { RUNNER } from '@/play/arcade/pieces/runner';
import { SHOOTER } from '@/play/arcade/pieces/shooter';

import { HorizonBackdrop } from './look/Backdrop';
import { FieldGround } from './look/FieldGround';
import type { Box } from './look/ground';
import { Landmark } from './look/Landmark';
import type { Volume } from './look/landmark-places';
import { Scenery } from './look/Scenery';
import { UNDER_PANORAMA } from './look/under-panorama';
import { Vegetation, VegetationAround } from './look/Vegetation';
import { LAYERS, type Layer, type RoadAt, type Side } from './look/vegetation-places';

/**
 * Mýtina střelnice jako „cesta“ vegetace: celý kužel míření ±45° od hráče (z = 0)
 * a 4 m navíc – nepřítel i terč stojí vždy v něm a do 36 m (`SHOOTER.range`).
 * Za 40 m ji uzavře les, za hráčem nic (kamera).
 */
const RANGE_CLOSE = 40;
const rangeAt = (z: number): RoadAt => ({ center: 0, half: z < RANGE_CLOSE ? 4 + Math.max(0, z) : 0 });
/** Hřiště hodu ve scéně (m): míček letí v rovině x = 0 od −3 do 27 m (`ThrowRig` VIEW). */
const THROW_FIELD: Box = { x0: -2, x1: 2, z0: -3, z1: 27 };
/** Vegetace hodu jen za hřištěm (+x, boční kamera stojí na −x) a za cílem (+z); před kamerou a za hráčem nic. */
const THROW_LAYERS: Readonly<Record<Side, readonly Layer[]>> = { '-x': [], '+x': LAYERS, '-z': [], '+z': LAYERS };
/** Zem střelnice a hodu (m): kamery stojí do 9 m za hráčem, mlha sad končí do 140 m. */
const RANGE_LAND: Box = { x0: -70, x1: 70, z0: -30, z1: 110 };
/**
 * Nejbližší vrstva kulisy za mlhou (m od kamery, `backdropLayers`): střelnice – dostřel 36 m
 * a kamera 5,5 m za hráčem; hod – boční kamera ~16–20 m od hřiště a kulisy 13–18 m za ním;
 * poletování – boční kamera 26–30 m od trubek a kulisy dvojnásobné velikosti za nimi.
 */
const BEYOND = { shooter: 46, throw: 34, flap: 44 } as const;

/**
 * Hrací plocha pro orientační bod a rámující kusy (P54B T8): poletování – pás pod trubkami
 * po celé trati; střelnice – kužel míření ±45° až do dostřelu; hod – hřiště.
 */
const FLAP_AREA: readonly Box[] = [{ x0: -1.5, x1: 1.5, z0: -Infinity, z1: Infinity }];
const FLAP_GROUND = (): number => -0.4;
/** Trubky poletování po celé trati, od země po strop (P54B T15a): bod za nimi by v obraze stál přímo v mezeře. */
const FLAP_PLAY: readonly Volume[] = [{ x0: -1.5, y0: -0.4, z0: -Infinity, x1: 1.5, y1: FLAP.ceiling / UNIT, z1: Infinity }];
const SHOOTER_AREA: readonly Box[] = [{ x0: -(4 + SHOOTER.range / UNIT), x1: 4 + SHOOTER.range / UNIT, z0: -2, z1: SHOOTER.range / UNIT }];
const THROW_AREA: readonly Box[] = [THROW_FIELD];

/** Podklad scény v barvách sady prostředí (P26 T11): dráha běžce, hladina pod plošinami, zem pod trubkami, rekvizity. */
export function WorldBackdrop({ control, length, look, seed }: { readonly control: string; readonly length: number; readonly look: Look; readonly seed: number }) {
  const span = length + 60;
  if (control === 'platform') {
    const water = PLATFORM.fallBelowY / UNIT - 0.4;
    return (
      <>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, water, span / 2 - 30]}>
          <planeGeometry args={[80, span]} />
          <meshStandardMaterial color={look.water} roughness={0.3} />
        </mesh>
        <Scenery look={look} layout="behind" inner={11} from={-20} to={length + 20} y={water} size={1.6} />
      </>
    );
  }
  if (control === 'flap') {
    // Úzký pás země: z boku je to proužek pod trubkami a za ním obloha. Široká
    // plocha by z výšky kamery zabrala spodní půlku obrazu a spolkla dolní trubky.
    return (
      <>
        <mesh position={[0, -0.4, span / 2 - 30]}>
          <boxGeometry args={[3, 0.8, span]} />
          <meshStandardMaterial color={look.ground} roughness={1} />
        </mesh>
        {/* Boční kamera vidí kulisy za tratí malé a v mlze: dvojnásobná velikost (P28D T6). */}
        <Scenery look={look} layout="behind" inner={12} from={-20} to={length + 20} y={-0.4} size={2} />
        {/* Kulisa za mlhou za kulisami, pata 0,45 m pod zemí (kulisy stojí na −0,4 m); vegetace ne – pás země je úzký a za ním nebe. */}
        <HorizonBackdrop look={look} seed={seed} length={length} clear={0} beyond={BEYOND.flap} skirt={0.45} />
        {/* Orientační bod za tratí jede s boční kamerou (P54B T8). */}
        <Landmark look={look} seed={seed} area={FLAP_AREA} ground={FLAP_GROUND} play={FLAP_PLAY} follow="track" />
      </>
    );
  }
  if (control === 'shooter' || control === 'throw') {
    return (
      <>
        <FieldGround look={look} area={RANGE_LAND} y={-0.01} under podium={false} />
        {control === 'shooter' ? (
          <>
            {look.flora !== undefined && <Vegetation flora={look.flora} seed={seed} from={-2} to={RANGE_LAND.z1} road={rangeAt} clear={1.5} />}
            <Scenery look={look} layout="sides" inner={14} from={-4} to={60} size={1.5} vegetation />
          </>
        ) : (
          <>
            {/* Boční kamera vidí po z daleko do stran: okno vegetace drží i 60 m za kamerou. */}
            {look.flora !== undefined && <VegetationAround flora={look.flora} seed={seed} box={THROW_FIELD} clear={4} layers={THROW_LAYERS} behind={60} />}
            <Scenery look={look} layout="behind" inner={13} from={-10} to={45} size={1.5} vegetation />
          </>
        )}
        <HorizonBackdrop look={look} seed={seed} clear={0} beyond={BEYOND[control as 'shooter' | 'throw']} />
        {/* Orientační bod za dostřelem či hřištěm a rámující kusy v popředí (P54B T8). */}
        <Landmark look={look} seed={seed} area={control === 'shooter' ? SHOOTER_AREA : THROW_AREA} />
      </>
    );
  }
  const trackLength = length + 20;
  const trackWidth = (RUNNER.lanes * RUNNER.laneWidth) / UNIT;
  const laneWidth = RUNNER.laneWidth / UNIT;
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, trackLength / 2 - 10]}>
        <planeGeometry args={[trackWidth + 0.6, trackLength]} />
        <meshStandardMaterial color={look.track} roughness={LOOK_STYLE.floor.roughness} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, trackLength / 2 - 10]} renderOrder={UNDER_PANORAMA}>
        <planeGeometry args={[80, trackLength + 80]} />
        <meshStandardMaterial color={look.ground} roughness={1} depthWrite={false} />
      </mesh>
      <Scenery look={look} layout="sides" inner={trackWidth / 2 + 2.5} from={-10} to={trackLength - 10} />
      {[-0.5, 0.5].map((edge) => (
        <mesh key={edge} rotation={[-Math.PI / 2, 0, 0]} position={[edge * laneWidth, 0, trackLength / 2 - 10]}>
          <planeGeometry args={[0.08, trackLength]} />
          <meshBasicMaterial color={LOOK_STYLE.floor.laneLine} />
        </mesh>
      ))}
    </>
  );
}
