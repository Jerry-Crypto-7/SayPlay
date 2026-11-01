'use client';

/**
 * Scéna „najdi anomálii“ z očí (P68-F T11). **Zatím nevolaná** – hotový vzhled pro registraci v P68-I / P69C
 * (`evals/play/p68/prvni-osoba/integration.md`). Hráč stojí uprostřed místnosti z věty; kamera jen sleduje natočení
 * ze stavu (`railfps-camera.ts`, táž póza jako střelnice), hra kameru nečte.
 *
 * V každém sektoru stojí předměty místnosti z pravidla `railfps_spot` (`room`): tvar = rekvizita místa z věty
 * (`look.props`), barva = podstavec z tokenů kitu (u jednoduché rekvizity i ona sama), řádek výšky = podstavec na
 * sloupku. Od tiku změny kola scéna změnu ukáže: jiná barva, jiná velikost, předmět chybí, nebo přibyl. Mimo kolo
 * (přestávka háčků, hodiny minulého kola) se ukazuje místnost beze změny.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { Suspense, useContext, useEffect, useMemo, useRef } from 'react';
import type { Group, MeshStandardMaterial, PerspectiveCamera } from 'three';

import { color } from '@/brand/tokens';
import { baseControlOf } from '@/play/arcade/addons';
import { UNIT, bodyBase } from '@/play/arcade/contract';
import { inBreak, roundOf } from '@/play/arcade/hooks';
import { isSceneryModel, type SceneryKind } from '@/play/arcade/look';
import { SPOT, SPOT_CHANGE, type RailfpsSpotControlParams, type RailfpsSpotRuleParams, type SpotChange, type SpotItem } from '@/play/arcade/pieces/railfps-anomaly';
import { RIG, YAW, clockOf, yawStepOf } from '@/play/arcade/pieces/railfps-world';

import { renderHeld } from '../../effects/render-feel';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { Panorama } from '../../look/Panorama';
import { PlayEnv } from '../../look/play-env';
import { SceneryModelProp } from '../../look/Scenery';
import { playRect, usePlayRectRef } from '../../portrait-frame';
import type { WorldProps } from '../../World';
import { HUD_BAND_PX, THUMB_ZONE_PX } from '../portrait-first';
import { applyPose, cameraPose } from './railfps-camera';

/** Barvy předmětů (index `SpotItem[4]`): tokeny kitu bez rajčatové – ta patří jediné akci obrazovky. */
const PAINT = [color.sun, color.sky, color.mint, color.bubblegum] as const;
/** Výška podstavce v řádku výšky (m) a odklon předmětů v sektoru od jeho osy (°). */
const SHELF_M = [0, 0.6, 1.2] as const;
const SPREAD_DEG = 4;
const GROUND_AREA = { x0: -30, x1: 30, z0: -30, z1: 30 };
/** Jednoduchá rekvizita bez modelu: kvádr (m). */
const BLOCK = { w: 0.6, h: 0.8 } as const;

const rad = (deg: number): number => (deg * Math.PI) / 180;
const keyOf = (sector: number, index: number): string => `${String(sector)}:${String(index)}`;

/** Poloha předmětu: úhel sektoru ± odklon podle indexu, kladný sektor doprava (−x scény). */
function placeOf(sector: number, index: number, distance: number): readonly [number, number] {
  const deg = sector * YAW.stepDeg + (index === 0 ? -SPREAD_DEG : index === 1 ? SPREAD_DEG : 0);
  const d = distance / UNIT;
  return [-Math.sin(rad(deg)) * d, Math.cos(rad(deg)) * d];
}

/** Jeden předmět: podstavec v barvě na sloupku v řádku výšky a rekvizita místa navrchu. */
function Item({ kind, row, paint, onPaint }: { readonly kind: SceneryKind; readonly row: number; readonly paint: string; readonly onPaint?: (material: MeshStandardMaterial | null) => void }) {
  const shelf = SHELF_M[row] ?? 0;
  return (
    <group>
      {shelf > 0 && (
        <mesh position={[0, shelf / 2, 0]}>
          <cylinderGeometry args={[0.05, 0.05, shelf, 8]} />
          <meshStandardMaterial color={color.ink} roughness={0.7} />
        </mesh>
      )}
      <mesh position={[0, shelf + 0.05, 0]} receiveShadow>
        <cylinderGeometry args={[0.4, 0.4, 0.1, 24]} />
        <meshStandardMaterial ref={onPaint} color={paint} roughness={0.8} />
      </mesh>
      <group position={[0, shelf + 0.1, 0]}>
        {isSceneryModel(kind) ? (
          <Suspense fallback={null}>
            <SceneryModelProp id={kind} />
          </Suspense>
        ) : (
          <mesh position={[0, BLOCK.h / 2, 0]} castShadow>
            <boxGeometry args={[BLOCK.w, BLOCK.h, BLOCK.w]} />
            <meshStandardMaterial ref={onPaint} color={paint} roughness={0.8} />
          </mesh>
        )}
      </group>
    </group>
  );
}

type AnomalySceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

export function AnomalyScene({ session, scene: look }: AnomalySceneProps) {
  const world = session.world;
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const size = useThree((three) => three.size);
  const measured = usePlayRectRef();
  const env = useContext(PlayEnv);
  const { keeper, hooks } = useMemo(() => baseControlOf(world.control).params as RailfpsSpotControlParams, [world]);
  const { room, rounds } = useMemo(() => world.rules.find((ref) => ref.id === 'railfps_spot')?.params as RailfpsSpotRuleParams, [world]);
  const shapes: readonly SceneryKind[] = look.props.length > 0 ? look.props : ['crate'];
  const shapeOf = (index: number): SceneryKind => shapes[index % shapes.length] as SceneryKind;

  const groups = useRef(new Map<string, Group | null>());
  const paints = useRef(new Map<string, (MeshStandardMaterial | null)[]>());
  const extras = useRef<(Group | null)[]>([]);
  const shown = useRef<SpotChange | null>(null);

  const paintRef = (key: string) => (material: MeshStandardMaterial | null) => {
    const list = paints.current.get(key) ?? [];
    if (material !== null && !list.includes(material)) list.push(material);
    paints.current.set(key, list);
  };

  // Vlastní pole a posun záběru jen pro tuhle scénu; po odchodu se vrátí.
  useEffect(() => {
    const fov = camera.fov;
    return () => {
      camera.fov = fov;
      camera.clearViewOffset();
      camera.updateProjectionMatrix();
    };
  }, [camera]);

  /** Vrátí předmět změny `change` do podoby z místnosti, nebo ukáže změnu. */
  const apply = (change: SpotChange, on: boolean): void => {
    const [, sector, index, kind, value] = change;
    if (kind === SPOT_CHANGE.extra) {
      const group = extras.current[rounds.indexOf(change)];
      if (group != null) group.visible = on;
      return;
    }
    const item = room.find(([s, n]) => s === sector && n === index) as SpotItem;
    const key = keyOf(sector, index);
    const group = groups.current.get(key);
    if (group == null) return;
    group.visible = !(on && kind === SPOT_CHANGE.missing);
    group.scale.setScalar(((on && kind === SPOT_CHANGE.size ? value : item[5]) as number) / 100);
    const paint = PAINT[on && kind === SPOT_CHANGE.colour ? value : item[4]] ?? color.sun;
    for (const material of paints.current.get(key) ?? []) material?.color.set(paint);
  };

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const rect = measured.current ?? playRect(size, HUD_BAND_PX, size.height - THUMB_ZONE_PX);
    applyPose(camera, cameraPose(yawStepOf(prev, keeper), yawStepOf(state, keeper), alpha, camera.aspect, rect), size.width, size.height);

    const round = roundOf(state, hooks);
    const change = rounds[round];
    // Hodiny patří kolu až po jeho prvním tiku; v přestávce místnost beze změny.
    const live = change !== undefined && !inBreak(state, hooks) && state[bodyBase(keeper) + RIG.round] === round && clockOf(state, keeper) >= change[0];
    const next = live ? change : null;
    if (next === shown.current) return;
    if (shown.current !== null) apply(shown.current, false);
    if (next !== null) apply(next, true);
    shown.current = next;
  });

  return (
    <>
      <FieldGround look={look} area={GROUND_AREA} y={-0.02} under={env !== null} />
      {env === null ? (
        <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={SPOT.far / UNIT + 8} />
      ) : (
        <Suspense fallback={null}>
          <Panorama env={env} />
        </Suspense>
      )}
      {room.map(([sector, index, shape, row, paint, scale, distance]) => {
        const key = keyOf(sector, index);
        const [x, z] = placeOf(sector, index, distance);
        return (
          <group
            key={key}
            ref={(group) => {
              groups.current.set(key, group);
            }}
            position={[x, 0, z]}
            scale={scale / 100}
            userData={{ frame: 'target', item: 'anomaly-item' }}
          >
            <Item kind={shapeOf(shape)} row={row} paint={PAINT[paint] ?? color.sun} onPaint={paintRef(key)} />
          </group>
        );
      })}
      {/* Předmět, který v kole přibude (druh `extra`, hodnota = tvar): stojí na zemi uprostřed pásu sektoru změny. */}
      {rounds.map((change, k) => {
        if (change[3] !== SPOT_CHANGE.extra) return null;
        const [x, z] = placeOf(change[1], SPOT.perSector, (SPOT.near + SPOT.far) / 2);
        return (
          <group
            key={`extra-${String(k)}`}
            ref={(group) => {
              extras.current[k] = group;
            }}
            position={[x, 0, z]}
            visible={false}
            userData={{ frame: 'target', item: 'anomaly-extra' }}
          >
            <Item kind={shapeOf(change[4])} row={0} paint={color.sun} />
          </group>
        );
      })}
    </>
  );
}
