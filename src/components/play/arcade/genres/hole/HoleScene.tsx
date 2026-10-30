'use client';

/**
 * Scéna díry (P66 T6): město nebo místo z věty shora pod úhlem, věci z věty a kulisy jeho sady, které díra polyká,
 * a největší věc (finále) uprostřed horní poloviny pole. x jádra se zrcadlí jako v aréně: kamera kouká po +z, takže
 * +x je na obrazovce vpravo a tah prstem doprava jde doprava (vstup arény, `STAGES.hole`).
 *
 * Jen obraz, mimo stav i hash:
 * - díra: inkoustový kotouč se stěnou a modrým okrajem v průměru stupně; po růstu se průměr dorovná plynule;
 * - pád: polknutá věc se svalí ke středu díry, zmenší se a zapadne pod okraj;
 * - hodiny kola nad dírou (`hole-clock`), pod 10 s rajčatové; v přestávce mezi koly schované (banner kola kreslí
 *   vrstva háčků);
 * - kamera: na výšku přes `fitTall` (`../portrait-first.ts`) – krabice kolem díry leží v pásu mezi HUD a zónou palce,
 *   díra v její spodní třetině, ať je vidět dopředu; na šířku vlastní póza. S růstem díry kamera couvne plynule.
 *
 * Věc věty nese `userData.item` = id své role (`item1`…), kulisa sady `kit`, finále `finale` – sonda záběru
 * (`__playFrame().items`) tak vidí, které věci věty jsou na obrazovce. Hrdina sondy (`frame: 'hero'`) je díra.
 */

import { Html } from '@react-three/drei/web/Html';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Box3, type Group, type MeshBasicMaterial, type PerspectiveCamera, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { baseControlOf } from '@/play/arcade/addons';
import { ARCADE_HZ, BODY, FLAG, HEADER, RUN_STATE, UNIT, bodyBase, nativeRule } from '@/play/arcade/contract';
import { inBreak } from '@/play/arcade/hooks';
import { HOLE, type HoleControlParams, roundStartOf, tierOf } from '@/play/arcade/pieces/hole';

import { renderHeld } from '../../effects/render-feel';
import { worldPlacement } from '../../Ghost';
import { GhostSlot } from '../../GhostSlot';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { type Cast, FittedModel, type WorldProps } from '../../World';
import { fitTall, tokenRect } from '../portrait-first';

const m = (units: number): number => units / UNIT;
const HALF = m(HOLE.half);
/** Pád věci do díry (s) a jak rychle se průměr díry a kamera dorovnají po růstu (1/s). */
const FALL_S = 0.5;
const GROW_RATE = 5;
/** Kamera: náklon dolů; na šířku díra zabere tolik výšky obrazu (`LEGIBLE_SHARE.hero` s rezervou). */
const CAMERA = { elevation: (62 * Math.PI) / 180, share: 0.24 } as const;
/**
 * Krabice na výšku kolem díry (násobky průměru): do stran, dozadu a dopředu. Na Pixelu 7 rozhoduje hloubka (`fitTall`
 * ji vepíše do výšky pásu): s 0,7 + 3,6 průměru měřila díra 18 % výšky obrazu a čitelnost ji vizuálně zvětšila o 15 %
 * nad průměr jádra; s 0,7 + 2,85 měří nad `LEGIBLE_SHARE.hero` a dopředu jsou vidět zhruba tři průměry.
 */
const BOX = { side: 0.8, back: 0.7, ahead: 2.85 } as const;
/** Na šířku míří pohled tolik průměrů před díru: díra stojí kolem 60 % výšky obrazu, nad dolní řadou HUD. */
const LANDSCAPE_LEAD = 0.45;
/** Pod tolika sekundami zrudnou hodiny kola. */
const HURRY_S = 10;

type HoleSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

/** Model věci podle druhu těla: věc věty (`thing:<role>`) z popisku role, kulisa sady je id modelu sama. */
function modelOfKind(kind: string, cast: Cast): string {
  if (!kind.startsWith('thing:')) return kind;
  return cast.things?.[kind.slice(6)] ?? 'crystal';
}

/** Položka sondy záběru: role věci věty, kulisa sady, nebo finále. */
const itemOfKind = (kind: string, finale: boolean): string => (finale ? 'finale' : kind.startsWith('thing:') ? kind.slice(6) : 'kit');

interface Thing {
  readonly body: number;
  readonly model: string;
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly size: number;
}

export function HoleScene({ session, cast, surface, scene: look, ghost }: HoleSceneProps) {
  const world = session.world;
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const params = baseControlOf(world.control).params as HoleControlParams;
  const seconds = Number(nativeRule(world.rules, 'hole_round')?.params.seconds ?? HOLE.seconds.default);

  const things = useMemo<Thing[]>(() => {
    const out: Thing[] = [];
    for (const body of [params.finale, ...Array.from({ length: params.count }, (_, k) => params.first + k)]) {
      const base = bodyBase(body);
      const kind = world.kinds[world.initial[base + BODY.kind] as number] ?? 'crystal';
      out.push({ body, model: modelOfKind(kind, cast), item: itemOfKind(kind, body === params.finale), x: -m(world.initial[base + BODY.x] as number), z: m(world.initial[base + BODY.z] as number), size: m(world.initial[base + BODY.w] as number) });
    }
    return out;
  }, [world, cast, params]);

  const groups = useRef<(Group | null)[]>([]);
  const hole = useRef<Group | null>(null);
  const mouth = useRef<Group | null>(null);
  const clockTag = useRef<HTMLSpanElement | null>(null);
  const clockAnchor = useRef<Group | null>(null);
  const rimMaterial = useRef<MeshBasicMaterial | null>(null);
  const memory = useRef({ falls: new Map<number, { age: number; fromX: number; fromZ: number }>(), diameter: m(HOLE.tiers[0] as number), seen: -1 });
  const scratch = useMemo(() => ({ look: new Vector3(), probe: new Vector3(), box: new Box3(), at: new Vector3(), dir: new Vector3() }), []);

  // Posun záběru na výšku patří jen téhle scéně: odchod ho vrátí.
  useEffect(() => () => camera.clearViewOffset(), [camera]);

  useFrame(({ size }, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const player = state[HEADER.player] as number;
    const base = bodyBase(player);
    const hx = -m((prev[base + BODY.x] as number) + ((state[base + BODY.x] as number) - (prev[base + BODY.x] as number)) * alpha);
    const hz = m((prev[base + BODY.z] as number) + ((state[base + BODY.z] as number) - (prev[base + BODY.z] as number)) * alpha);
    const target = m(HOLE.tiers[tierOf(state, params)] as number);
    const tick = state[HEADER.tick] as number;
    const memo = memory.current;
    // Restart relace (tik zpět): díra zase malá a pády zapomenuté.
    if (tick < memo.seen) {
      memo.falls.clear();
      memo.diameter = target;
    }
    memo.seen = tick;
    memo.diameter += (target - memo.diameter) * Math.min(1, delta * GROW_RATE);
    const diameter = memo.diameter;

    if (hole.current !== null) hole.current.position.set(hx, 0, hz);
    mouth.current?.scale.set(diameter, 1, diameter);

    // Věci: živá stojí, polknutá se svalí ke středu díry a zapadne.
    for (let slot = 0; slot < things.length; slot += 1) {
      const thing = things[slot] as Thing;
      const group = groups.current[slot];
      if (group === null || group === undefined) continue;
      const alive = ((state[bodyBase(thing.body) + BODY.flags] as number) & FLAG.alive) !== 0;
      if (alive) {
        memo.falls.delete(thing.body);
        group.visible = true;
        group.position.set(thing.x, 0, thing.z);
        group.rotation.set(0, 0, 0);
        group.scale.setScalar(1);
        continue;
      }
      const fall = memo.falls.get(thing.body) ?? { age: 0, fromX: thing.x, fromZ: thing.z };
      fall.age += delta;
      memo.falls.set(thing.body, fall);
      const p = Math.min(1, fall.age / FALL_S);
      group.visible = p < 1;
      if (p >= 1) continue;
      const pull = p * p;
      group.position.set(fall.fromX + (hx - fall.fromX) * pull, -thing.size * 1.2 * pull, fall.fromZ + (hz - fall.fromZ) * pull);
      group.rotation.set(p * 1.1, 0, p * 0.4);
      group.scale.setScalar(1 - 0.75 * p);
    }

    // Hodiny kola nad dírou: před prvním tikem (karta „Tap to start“ stojí přes střed), v přestávce a po konci schované.
    const tag = clockTag.current;
    const running = tick > 0 && state[HEADER.runState] === RUN_STATE.running && !inBreak(state, params.keeper);
    const left = Math.max(0, seconds - Math.floor((tick - roundStartOf(state, player)) / ARCADE_HZ));
    clockAnchor.current?.position.set(0, 0.35, diameter * 0.5 + 0.2);
    if (tag !== null) {
      const text = `${String(left)}s`;
      if (tag.textContent !== text) tag.textContent = text;
      tag.dataset.left = String(left);
      tag.className = left <= HURRY_S ? 'sp-world-tag' : 'sp-world-tag sp-world-tag--goal';
      tag.style.visibility = running ? 'visible' : 'hidden';
    }
    rimMaterial.current?.color.set(left <= HURRY_S && running ? color.tomato : color['sky-deep']);

    // Kamera: shora pod úhlem od −z, díra ve spodní třetině; průměr díry řídí vzdálenost, takže s růstem couvne plynule.
    const dir = scratch.dir.set(0, -Math.sin(CAMERA.elevation), Math.cos(CAMERA.elevation));
    if (camera.aspect < 1) {
      const box = scratch.box.set(scratch.at.set(hx - BOX.side * diameter, 0, hz - BOX.back * diameter), scratch.probe.set(hx + BOX.side * diameter, 0.2, hz + BOX.ahead * diameter));
      const center = box.getCenter(scratch.look);
      camera.position.copy(center).addScaledVector(dir, -10 * diameter);
      camera.lookAt(center);
      const rect = tokenRect(size.width, size.height);
      const fit = fitTall(camera, box, rect);
      camera.position.copy(center).addScaledVector(dir, -fit.distance);
      camera.lookAt(center);
      camera.setViewOffset(rect.width, rect.height, 0, fit.shift, rect.width, rect.height);
    } else {
      // Na šířku: díra zabere `CAMERA.share` výšky obrazu, pohled míří kus před ni.
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const distance = (diameter * Math.sin(CAMERA.elevation)) / (CAMERA.share * 2 * tan);
      const center = scratch.look.set(hx, 0, hz + diameter * LANDSCAPE_LEAD);
      camera.position.copy(center).addScaledVector(dir, -distance);
      camera.lookAt(center);
      camera.clearViewOffset();
    }
    const host = surface.current;
    if (host === null) return;
    camera.updateMatrixWorld();
    host.dataset.playerX = scratch.probe.set(hx, 0, hz).project(camera).x.toFixed(3);
    host.dataset.holeTier = String(tierOf(state, params));
  });

  return (
    <>
      <FieldGround look={look} area={{ x0: -HALF - 30, x1: HALF + 30, z0: -HALF - 30, z1: HALF + 40 }} y={-0.03} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={HALF + 12} />
      {things.map((thing, slot) => (
        <group
          key={thing.body}
          ref={(group) => {
            groups.current[slot] = group;
          }}
          position={[thing.x, 0, thing.z]}
          userData={{ item: thing.item }}
        >
          <FittedModel id={thing.model} w={thing.size} h={thing.size} d={thing.size} fallback={thing.item === 'kit' ? look.tint[0] : color.sun} />
        </group>
      ))}
      <group ref={hole} userData={{ frame: 'hero', item: 'hole' }}>
        <group ref={mouth}>
          {/* Stěna díry (světlejší inkoust u okraje), dno a okraj; jednotkový průměr, škáluje se průměrem stupně. */}
          <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.5, 48]} />
            <meshBasicMaterial color={color['ink-soft']} polygonOffset polygonOffsetFactor={-2} />
          </mesh>
          <mesh position={[0, 0.016, 0.05]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.43, 48]} />
            <meshBasicMaterial color={color.ink} polygonOffset polygonOffsetFactor={-3} />
          </mesh>
          <mesh position={[0, 0.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.5, 0.035, 8, 48]} />
            <meshBasicMaterial ref={rimMaterial} color={color['sky-deep']} />
          </mesh>
        </group>
        <group ref={clockAnchor}>
          <Html center pointerEvents="none" zIndexRange={[10, 0]}>
            <span ref={clockTag} className="sp-world-tag sp-world-tag--goal" data-testid="hole-clock" style={{ visibility: 'hidden' }} />
          </Html>
        </group>
      </group>
      <GhostSlot ghost={ghost} session={session} place={worldPlacement} />
    </>
  );
}
