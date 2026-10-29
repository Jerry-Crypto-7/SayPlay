'use client';

/**
 * Scéna krádeže (P66 T7): úzké hřiště na výšku, domovská základna dole (mátová podložka), cizí nahoře (rajčatově
 * lemovaná). Hrdina, kořist a strážci z věty stojí tam, kde jsou jejich tělesa v jádře (poloha interpolovaná mezi
 * tiky); x jádra se zrcadlí jako v aréně – kamera kouká po +z, tah prstem doprava jde doprava.
 *
 * Kamera jde za hrdinou: na výšku přes `../portrait-first.ts` (`fitTall`) – celá šířka hřiště a kus cesty před
 * hrdinou leží v pásu mezi horním pásem HUD a zónou palce, hrdina ve spodní části; na šířku vlastní póza za hrdinou.
 *
 * Jen obraz, mimo stav i hash: nesená kořist nad hlavou hrdiny, kroužek vzácnosti pod kořistí (běžná inkoust, vzácná
 * modrozelená, epická slunečná), štítek „Home“ nad domovem, když hrdina něco nese, „Run!“ nad strážcem, který honí,
 * a odpočet kola nad cizí základnou v posledních sekundách. Vstup je vstup arény (`STAGES.steal`: tah = směr).
 */

import { Html } from '@react-three/drei/web/Html';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { Group, Mesh, MeshBasicMaterial, PerspectiveCamera } from 'three';
import { Box3, Color, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { ARCADE_HZ, BODY, FLAG, HEADER, UNIT, bodyBase, nativeRule } from '@/play/arcade/contract';
import { rarityOf } from '@/play/arcade/hooks';
import { riggedCharacter } from '@/play/arcade/models';
import { BASE_EDGE, LOOT, STEAL, type StealControlParams, chasing, lootState, roundStartOf } from '@/play/arcade/pieces/steal';
import type { ClipState } from '@/play/arcade/motion';

import { renderHeld } from '../../effects/render-feel';
import { worldPlacement } from '../../Ghost';
import { GhostSlot } from '../../GhostSlot';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps } from '../../World';
import { fitTall, tokenRect } from '../portrait-first';

const m = (units: number): number => units / UNIT;
const HALF = m(STEAL.half);
const LENGTH = m(STEAL.length);
/** Postavy (m): kolizní tělesa jádra jsou kvádry, postava stojí na zemi. */
const HERO = { w: 0.9, h: 1.4, d: 0.8 } as const;
const GUARD = { w: 1.0, h: 1.6, d: 0.9 } as const;
const BOSS = { w: 1.4, h: 2.2, d: 1.2 } as const;
/** Skok dál než tohle (m) mezi tiky je návrat domů nebo nové kolo, ne pohyb – neinterpoluje se. */
const JUMP = 2.5;
/**
 * Kamera: náklon, kus hřiště za hrdinou a před ním (m), které musí být vidět, a na šířku vzdálenost a předstih
 * pohledu. Na výšku 8,4 m šířky drží hrdinu (2× čitelnost) nad pětinou výšky obrazu.
 */
const CAMERA = { elevation: (56 * Math.PI) / 180, behind: 3, ahead: 8, wide: { distance: 11.5, lead: 3.2, edge: 3 }, ease: 6 } as const;
/** Kořist se kreslí větší než její kolizní těleso (jen obraz): rybka 0,7 m by na telefonu splynula s dlažbou. */
const LOOT_LOOK = 1.6;
/** Odpočet kola nad cizí základnou od tolika zbývajících sekund. */
const COUNTDOWN_S = 8;
/** Výchozí modely, když popisek věty model nemá. */
const DEFAULT_LOOT = 'crystal';
const DEFAULT_GUARD = 'robot';

type StealSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

/** Natočení postavy čelem po směru jádra (`dx`, `dz`): x scény je zrcadlené, model kouká po +z. */
const yawOf = (dx: number, dz: number): number => Math.atan2(-dx, dz);

const RARE = new Color(color.mint).lerp(new Color(color.sky), 0.5);
const RING: Readonly<Record<'common' | 'rare' | 'epic', Color>> = { common: new Color(color.ink), rare: RARE, epic: new Color(color.sun) };

/** Postava z popisku: riggovaná (s klipem chůze), nebo model vepsaný do kvádru. */
function Figure({ model, size, tint, clip }: { readonly model: string; readonly size: { readonly w: number; readonly h: number; readonly d: number }; readonly tint: string; readonly clip: () => ClipState }) {
  const rig = riggedCharacter(model);
  return rig !== undefined ? <RiggedModel character={rig} h={size.h} clip={clip} fallback={tint} /> : <FittedModel id={model} w={size.w} h={size.h} d={size.d} fallback={tint} character />;
}

export function StealScene({ session, cast, surface, scene: look, ghost }: StealSceneProps) {
  const world = session.world;
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const size = useThree((three) => three.size);
  const params = world.control.params as StealControlParams;
  const lootModel = cast.props.coin ?? DEFAULT_LOOT;
  const guardModel = cast.chaser || DEFAULT_GUARD;
  const ticks = Number(nativeRule(world.rules, 'steal_clock')?.params.ticks ?? 0);

  const hero = useRef<Group | null>(null);
  const heroClip = useRef<ClipState>('idle');
  const guards = useRef<(Group | null)[]>([]);
  const guardClips = useRef<ClipState[]>([]);
  const runTags = useRef<(HTMLSpanElement | null)[]>([]);
  const loot = useRef<(Group | null)[]>([]);
  const rings = useRef<(Mesh | null)[]>([]);
  const homeTag = useRef<HTMLSpanElement | null>(null);
  const clockTag = useRef<HTMLSpanElement | null>(null);
  const lookZ = useRef<number | null>(null);
  const scratch = useMemo(() => ({ box: new Box3(), center: new Vector3(), dir: new Vector3(), probe: new Vector3() }), []);

  // Posun záběru na výšku patří jen téhle scéně.
  useEffect(() => () => camera.clearViewOffset(), [camera]);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const running = state[HEADER.runState] === 0;
    /** Poloha těla ve scéně (m), interpolovaná; skok (domů, nové kolo) se neinterpoluje. */
    const place = (body: number): { x: number; z: number } => {
      const base = bodyBase(body);
      const nx = state[base + BODY.x] as number;
      const nz = state[base + BODY.z] as number;
      const px = prev[base + BODY.x] as number;
      const pz = prev[base + BODY.z] as number;
      const fresh = ((prev[base + BODY.flags] as number) & FLAG.alive) === 0 || Math.hypot(m(nx - px), m(nz - pz)) > JUMP;
      return fresh ? { x: -m(nx), z: m(nz) } : { x: -m(px + (nx - px) * alpha), z: m(pz + (nz - pz) * alpha) };
    };
    const alive = (body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
    const player = state[HEADER.player] as number;
    const p = bodyBase(player);

    // Hrdina: čelem po směru, klip podle rychlosti.
    const heroAt = place(player);
    const vx = state[p + BODY.vx] as number;
    const vz = state[p + BODY.vz] as number;
    heroClip.current = Math.hypot(vx, vz) > 20 && running ? 'run' : 'idle';
    if (hero.current !== null) {
      hero.current.position.set(heroAt.x, 0, heroAt.z);
      if (vx !== 0 || vz !== 0) hero.current.rotation.y = yawOf(vx, vz);
    }

    // Kořist: na zemi s kroužkem vzácnosti, nesená nad hlavou hrdiny – nad hlavou, jak ji zvětšila čitelnost hrdiny.
    let carrying = 0;
    const heroScale = Number(hero.current?.userData.legible ?? 1);
    let stack = HERO.h * heroScale + 0.1;
    params.loot.spots.forEach((_spot, k) => {
      const body = params.loot.first + k;
      const group = loot.current[k];
      if (group === null || group === undefined) return;
      const on = alive(body);
      group.visible = on;
      if (!on) return;
      const held = lootState(state, body) === LOOT.carried;
      const at = held ? heroAt : place(body);
      const lift = held ? stack : 0;
      if (held) {
        carrying += 1;
        stack += m(state[bodyBase(body) + BODY.h] as number) * LOOT_LOOK;
      }
      group.position.set(at.x, lift, at.z);
      group.rotation.y += delta * (held ? 0 : 0.8);
      const ring = rings.current[k];
      if (ring !== null && ring !== undefined) {
        const rarity = rarityOf(state, body);
        ring.visible = !held && rarity !== undefined;
        if (rarity !== undefined) (ring.material as MeshBasicMaterial).color.copy(RING[rarity]);
      }
    });

    // Strážci: čelem k hrdinovi, když honí; „Run!“ nad těmi, kdo honí (nejvýš tři).
    let tags = 0;
    params.guards.posts.forEach((_post, k) => {
      const body = params.guards.first + k;
      const group = guards.current[k];
      const tag = runTags.current[k];
      if (group === null || group === undefined) return;
      const on = alive(body);
      group.visible = on;
      const hunting = on && chasing(state, body);
      if (tag !== null && tag !== undefined) {
        const show = hunting && running && tags < 3;
        if (show) tags += 1;
        tag.style.visibility = show ? 'visible' : 'hidden';
      }
      if (!on) return;
      const at = place(body);
      group.position.set(at.x, 0, at.z);
      const gx = state[bodyBase(body) + BODY.vx] as number;
      const gz = state[bodyBase(body) + BODY.vz] as number;
      if (gx !== 0 || gz !== 0) group.rotation.y = yawOf(gx, gz);
      guardClips.current[k] = Math.hypot(gx, gz) > 60 ? 'run' : Math.hypot(gx, gz) > 0 ? 'walk' : 'idle';
    });

    // Štítky: domov, když hrdina nese kořist; odpočet kola v posledních sekundách.
    if (homeTag.current !== null) homeTag.current.style.visibility = carrying > 0 && running ? 'visible' : 'hidden';
    if (clockTag.current !== null) {
      const left = ticks > 0 ? Math.ceil((ticks - ((state[HEADER.tick] as number) - roundStartOf(state, params.keeper))) / ARCADE_HZ) : Infinity;
      const text = running && left <= COUNTDOWN_S && left > 0 ? `${String(left)} s left` : '';
      if (clockTag.current.textContent !== text) clockTag.current.textContent = text;
      clockTag.current.style.visibility = text === '' ? 'hidden' : 'visible';
    }

    // Kamera za hrdinou; pohled jede plynule (mimo hash), aby skok domů nezatřásl záběrem.
    // Na výšku drží okno celé na hřišti (u základen hrdina sjede k okraji okna), na šířku pohled nejdál `edge` od konce.
    const reach = camera.aspect < 1 ? LENGTH - (CAMERA.ahead + CAMERA.behind) / 2 : LENGTH - CAMERA.wide.edge;
    const goal = Math.max(-reach, Math.min(reach, heroAt.z + (camera.aspect < 1 ? (CAMERA.ahead - CAMERA.behind) / 2 : CAMERA.wide.lead)));
    lookZ.current = lookZ.current === null ? goal : lookZ.current + (goal - lookZ.current) * Math.min(1, delta * CAMERA.ease);
    const z = lookZ.current;
    scratch.dir.set(0, Math.sin(CAMERA.elevation), -Math.cos(CAMERA.elevation));
    if (camera.aspect < 1) {
      scratch.box.min.set(-HALF - 0.3, 0, z - (CAMERA.ahead + CAMERA.behind) / 2);
      scratch.box.max.set(HALF + 0.3, 1.2, z + (CAMERA.ahead + CAMERA.behind) / 2);
      scratch.box.getCenter(scratch.center);
      camera.position.copy(scratch.center).addScaledVector(scratch.dir, 20);
      camera.lookAt(scratch.center);
      const fit = fitTall(camera, scratch.box, tokenRect(size.width, size.height));
      camera.position.copy(scratch.center).addScaledVector(scratch.dir, fit.distance);
      camera.lookAt(scratch.center);
      camera.setViewOffset(size.width, size.height, 0, fit.shift, size.width, size.height);
    } else {
      camera.clearViewOffset();
      scratch.center.set(0, 0.6, z);
      camera.position.copy(scratch.center).addScaledVector(scratch.dir, CAMERA.wide.distance);
      camera.lookAt(scratch.center);
    }
    const host = surface.current;
    if (host === null) return;
    camera.updateMatrixWorld();
    host.dataset.playerX = scratch.probe.set(heroAt.x, HERO.h, heroAt.z).project(camera).x.toFixed(3);
  });

  const home = { z: m(STEAL.home.z), w: m(2 * STEAL.home.halfW), d: m(2 * STEAL.home.halfD) };
  const base = { z: m(STEAL.base.z), w: m(2 * STEAL.base.halfW) + 0.6, d: m(2 * STEAL.base.halfD), edge: m(BASE_EDGE) };
  return (
    <>
      <FieldGround look={look} area={{ x0: -HALF - 12, x1: HALF + 12, z0: -LENGTH - 12, z1: LENGTH + 20 }} y={-0.03} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={20} />
      {/* Okraje hřiště: dvě nízké inkoustové lišty podél. */}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * (HALF + 0.15), 0.1, 0]} receiveShadow>
          <boxGeometry args={[0.18, 0.2, 2 * LENGTH]} />
          <meshStandardMaterial color={color.ink} roughness={0.8} />
        </mesh>
      ))}
      {/* Domov: mátová podložka s papírovým lemem. */}
      <group position={[0, 0, home.z]} userData={{ item: 'home' }}>
        <mesh position={[0, 0.01, 0]} receiveShadow>
          <boxGeometry args={[home.w + 0.3, 0.02, home.d + 0.3]} />
          <meshStandardMaterial color={color.paper} roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.025, 0]} receiveShadow>
          <boxGeometry args={[home.w, 0.02, home.d]} />
          <meshStandardMaterial color={color['mint-deep']} roughness={0.9} />
        </mesh>
        {/* Na horním okraji domova, nízko: na telefonu by štítek nad středem padl pod dolní řadu HUD. */}
        <Html position={[0, 0.9, home.d / 2]} center pointerEvents="none" zIndexRange={[10, 0]}>
          <span ref={homeTag} className="sp-world-tag sp-world-tag--goal" data-testid="steal-home" style={{ visibility: 'hidden' }}>
            Home
          </span>
        </Html>
      </group>
      {/* Cizí základna: krémová plocha s rajčatovým okrajem vpředu – odtud kořist kradeš. */}
      <group position={[0, 0, base.z]} userData={{ item: 'base' }}>
        <mesh position={[0, 0.01, 0]} receiveShadow>
          <boxGeometry args={[base.w, 0.02, base.d]} />
          <meshStandardMaterial color={color['cream-deep']} roughness={0.95} />
        </mesh>
        <mesh position={[0, 0.03, base.edge - base.z]}>
          <boxGeometry args={[base.w, 0.03, 0.16]} />
          <meshStandardMaterial color={color['tomato-deep']} roughness={0.8} />
        </mesh>
        <Html position={[0, 2.6, 0.6]} center pointerEvents="none" zIndexRange={[10, 0]}>
          <span ref={clockTag} className="sp-world-tag" data-testid="steal-clock" style={{ visibility: 'hidden' }} />
        </Html>
      </group>
      <group ref={hero} userData={{ frame: 'hero' }}>
        <Figure model={cast.player} size={HERO} tint={color['sky-deep']} clip={() => heroClip.current} />
      </group>
      {params.loot.spots.map((_spot, k) => {
        const body = params.loot.first + k;
        const w = m(world.initial[bodyBase(body) + BODY.w] as number) * LOOT_LOOK;
        return (
          <group
            key={`loot-${String(k)}`}
            ref={(group) => {
              loot.current[k] = group;
            }}
            visible={false}
            userData={{ frame: 'target', item: 'loot' }}
          >
            <FittedModel id={lootModel} w={w} h={w} d={w} fallback={color.sun} />
            <mesh
              ref={(mesh) => {
                rings.current[k] = mesh;
              }}
              position={[0, 0.03, 0]}
              rotation={[-Math.PI / 2, 0, 0]}
              userData={{ glow: true, rigShadow: 'receive' }}
            >
              <ringGeometry args={[w * 0.55, w * 0.75, 24]} />
              <meshBasicMaterial color={color.ink} toneMapped={false} />
            </mesh>
          </group>
        );
      })}
      {params.guards.posts.map((post, k) => {
        const figure = post.boss === true ? BOSS : GUARD;
        return (
          <group
            key={`guard-${String(k)}`}
            ref={(group) => {
              guards.current[k] = group;
            }}
            visible={false}
            userData={{ frame: 'target', item: 'guard' }}
          >
            <Figure model={guardModel} size={figure} tint={color.tomato} clip={() => guardClips.current[k] ?? 'idle'} />
            <Html position={[0, figure.h + 0.45, 0]} center pointerEvents="none" zIndexRange={[10, 0]}>
              <span
                ref={(span) => {
                  runTags.current[k] = span;
                }}
                className="sp-world-tag"
                data-testid="steal-run"
                style={{ visibility: 'hidden' }}
              >
                Run!
              </span>
            </Html>
          </group>
        );
      })}
      <GhostSlot ghost={ghost} session={session} place={worldPlacement} />
    </>
  );
}
