'use client';

import { renderHeld } from '../effects/render-feel';

/**
 * Scéna načasování (P25H T5): pohled zepředu na věž, můstek nebo lištu.
 *
 * `z` hráče je v jádře počítadlo kol, ne poloha – základna se kreslí na
 * místě. Jezdec kyvuje po x, zelený sloupec ukazuje toleranci kolem středu,
 * položené díly (předlohy kol) se objeví, když je jádro oživí. Kamera jede
 * za výškou jezdce, ať je u vysoké věže vidět vršek. Modely zatím nejsou
 * (dodá P25F), všechno je primitivum.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { Group, Object3D, PerspectiveCamera } from 'three';
import { Vector3 } from 'three';

import { ARCADE_HZ, BODY, BUTTON, FLAG, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { RHYTHM, rhythmLaneAxis } from '@/play/arcade/pieces/rhythm';
import { TIMING, TIMING_SLOTS } from '@/play/arcade/pieces/timing';
import { type ToyPose, toyEventsLive, toyPoseOf, toyViewOf } from '@/play/arcade/toy-motion';
import type { HeroAction } from '@/play/spec';

import { type ArcadeGhost, GhostSlot, besideHero } from '../GhostSlot';
import { isTyping } from '../input';
import { HorizonBackdrop } from '../look/Backdrop';
import { FieldGround } from '../look/FieldGround';
import type { Box } from '../look/ground';
import { Landmark } from '../look/Landmark';
import { Scenery } from '../look/Scenery';
import type { ArcadeSession } from '../session';
import { applyToy, toyMotionOn, toyTickOf } from '../toy/applyToy';

const TAP_KEYS = new Set([' ', 'enter', 'arrowup', 'w']);
/** Klávesy drah rytmu zleva doprava (P36A T11). */
const LANE_KEYS = ['d', 'f', 'j', 'k'];

/**
 * Dráha rytmu pod prstem: hranice drah u lišty jako zlomky šířky plochy, které
 * zapisuje `RhythmScene` do `data-lane-edges` (mezi drahami 0|1, 1|2, 2|3).
 * `null`, dokud scéna hranice nezapsala.
 */
function laneUnder(element: HTMLElement, clientX: number): number | null {
  const edges = element.dataset.laneEdges?.split(',').map(Number);
  if (edges === undefined || edges.length !== RHYTHM.lanes - 1) return null;
  const rect = element.getBoundingClientRect();
  const at = (clientX - rect.left) / rect.width;
  return edges[0]! < edges.at(-1)! ? edges.filter((edge) => at > edge).length : edges.filter((edge) => at < edge).length;
}

/**
 * Ťuk kamkoli nebo mezerník/Enter/šipka nahoru = TAP (hned při stisku). Sdílí
 * rytmus; s `lanes` ťuk nese dráhu pod prstem a D/F/J/K dráhu klávesy (jádro ji
 * čte jen u hry s drahami, mezerník bere kteroukoli).
 */
export function useTapInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean, lanes = false): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const lane = lanes ? LANE_KEYS.indexOf(key) : -1;
      if (lane < 0 && !TAP_KEYS.has(key)) return;
      event.preventDefault();
      session.press(BUTTON.TAP, lane < 0 ? 0 : rhythmLaneAxis(lane));
    };
    const onDown = (event: PointerEvent) => {
      const lane = lanes ? laneUnder(element, event.clientX) : null;
      session.press(BUTTON.TAP, lane === null ? 0 : rhythmLaneAxis(lane));
    };
    window.addEventListener('keydown', onKey);
    element.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      element.removeEventListener('pointerdown', onDown);
    };
  }, [session, target, active, lanes]);
}

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

// Položené díly střídají dvě barvy, ať jsou vrstvy věže vidět; nic fialového.
const MARK_COLORS = ['#0ea5e9', '#14b8a6'];
const SLIDER_COLOR: Readonly<Record<string, string>> = { block: '#f59e0b', needle: '#dc2626', plank: '#a16207' };
const BASE_COLOR: Readonly<Record<string, string>> = { base: '#475569', bar: '#334155', pillar: '#57534e' };

/** Počáteční rozměry těla `index` v metrech a jeho druh – ze stavu, který svět začíná. */
export function initialBody(world: ArcadeSession['world'], index: number) {
  const at = bodyBase(index);
  const read = (slot: number): number => (world.initial[at + slot] as number) / UNIT;
  return { x: read(BODY.x), y: read(BODY.y), z: read(BODY.z), w: read(BODY.w), h: read(BODY.h), d: read(BODY.d), kind: world.kinds[world.initial[at + BODY.kind] as number] ?? '' };
}

/** Jak daleko za hrací plochou (m po +z) stojí řada kulis – za zemí hrací plochy. */
const SCENERY_BEHIND = 7;
/** Zem načasování (m): do stran za kyv jezdce, dozadu pod kulisy a do mlhy. */
const TIMING_LAND = { x0: -40, x1: 40, z0: -20, z1: 60 } as const;
/** Nejbližší vrstva kulisy (m od kamery 8+ m před věží): za řadou kulis (7–12 m za věží). */
const BACKDROP_BEYOND = 26;
/** Věž a kyv jezdce (±3 m a díl): orientační bod a rámující kusy stojí mimo (P54B T8). */
const TIMING_AREA: readonly Box[] = [{ x0: -(TIMING.amplitude / UNIT + 2), x1: TIMING.amplitude / UNIT + 2, z0: -2, z1: 2 }];

/** Model z popisku role vepsaný do kvádru těla (w × h × d, metry), postavený na zem. */
export type BodyModel = (w: number, h: number, d: number) => React.ReactNode;

/** Poskok po trefě (P45D T11): tak dlouho (s) je tělo ve vzduchu a tak vysoko (podíl výšky) vyskočí. */
const BEAT_HOP_S = 0.24;
const BEAT_HOP = 0.18;

/**
 * Hračková póza hráče rytmu a načasování (P45D T11). Výsledek ťuku leží jeden tik v `aux0`
 * hráče (body = trefa, −1 = minutí) a `toyViewOf` ho nečte, proto ho do pohledu dá tahle
 * funkce: trefa = poskok (od tiku trefy je tělo `BEAT_HOP_S` ve vzduchu, `toyPoseOf` ho
 * natáhne a po dopadu zmáčkne), minutí = zásah (cuknutí a zakymácení), výhra = oslava,
 * prohra = pád. Bez události tělo stojí – žádné pohupování do taktu (kit `09-motion.md`).
 * Čte jen stav a `tick` s podílem; `previous` je póza minulého snímku.
 */
export function beatPoseOf(state: Int32Array, prev: Int32Array, previous: ToyPose | null, tick: number, reduced: boolean): ToyPose {
  // Póza z pozdějšího tiku patří běhu před restartem.
  const memory = previous !== null && tick >= previous.at ? previous : null;
  const player = state[HEADER.player] as number;
  const view = toyViewOf(state, prev, player);
  // Po konci běhu stojí stav s výsledkem posledního ťuku – ten platí jen v tiku konce.
  const result = toyEventsLive(view, memory, tick) ? (state[bodyBase(player) + BODY.aux0] as number) : 0;
  // Stav je už po tiku trefy, ten se počítá celý – poskok je vidět hned v prvním snímku.
  const sinceHop = (at: number): number => (tick + 1 - at) / ARCADE_HZ;
  // Nová trefa začne nový poskok, i když minulý ještě nedopadl.
  const before = result > 0 && memory !== null ? { ...memory, grounded: true } : memory;
  const airborne = result > 0 || (before !== null && !before.grounded && sinceHop(before.airAt) < BEAT_HOP_S);
  // Hráč stojí na místě a třída těla mění jen chůzi, takže tu žádnou roli nehraje.
  const toy = toyPoseOf({ ...view, grounded: !airborne, hit: view.hit || result < 0 }, 'biped', before, tick, reduced);
  if (reduced || !airborne || !view.alive) return toy;
  const u = Math.min(1, sinceHop(toy.airAt) / BEAT_HOP_S);
  return { ...toy, hop: toy.hop + 4 * BEAT_HOP * u * (1 - u) };
}

/** Skupina pózy zpět do klidu (blok, který přestal být vrchním). */
function standStill(group: Object3D): void {
  group.position.set(0, 0, 0);
  group.rotation.set(0, 0, 0);
  group.scale.set(1, 1, 1);
  group.visible = true;
}

/** `blockModel` (P30B T4): díl věže z popisku role `block` („pancakes“), vyplní kvádr dílu; jen u stavění věže. */
export function TimingScene({
  session,
  look: scene,
  blockModel,
  ghost,
}: {
  readonly session: ArcadeSession;
  readonly look: Look;
  readonly blockModel?: BodyModel;
  readonly heroAction: HeroAction;
  readonly ghost?: ArcadeGhost;
}) {
  const world = session.world;
  const base = initialBody(world, 0);
  // Duch stojí u paty věže, vedle podstavy (hráčovo `z` jsou kola, ne dráha).
  const ghostSpot = useMemo(() => besideHero(0, 0, base.w / 2, 'x'), [base.w]);
  const sliderInit = initialBody(world, TIMING_SLOTS.slider);
  const target = initialBody(world, TIMING_SLOTS.target);
  const marks = (world.initial[HEADER.bodyCount] as number) - TIMING_SLOTS.marks;
  const baseKind = base.kind;
  const sliderKind = sliderInit.kind;
  const slider = useRef<Group | null>(null);
  const placed = useRef<(Object3D | null)[]>([]);
  // Hračková póza (P45D T11): vnitřní skupiny jezdce a položených dílů, póza minulého snímku a kolo vrchního dílu.
  const sliderPose = useRef<Group | null>(null);
  const placedPoses = useRef<(Group | null)[]>([]);
  const toyPose = useRef<ToyPose | null>(null);
  const posedRound = useRef(-1);
  // Jehla a prkno můstku nejsou díly věže – model z popisku nese jen `block`.
  const blocks = sliderKind === 'block' ? blockModel : undefined;
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look = useMemo(() => new Vector3(), []);
  const followY = useRef<number | null>(null);
  const top = (TIMING.baseH + marks * (baseKind === 'base' ? TIMING.blockH : 0)) / UNIT;

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const s = bodyBase(TIMING_SLOTS.slider);
    const group = slider.current;
    if (group !== null) {
      // Kamera kouká po +z, takže +x jádra jde na obrazovce vlevo – zrcadlí se jako u běžce.
      group.position.set(-lerp(prev[s + BODY.x] as number, state[s + BODY.x] as number, alpha) / UNIT, (state[s + BODY.y] as number) / UNIT, 0);
      group.scale.x = (state[s + BODY.w] as number) / UNIT / Math.max(0.001, sliderInit.w);
      group.visible = (state[s + BODY.vx] as number) !== 0;
    }
    placed.current.forEach((mesh, round) => {
      if (mesh === null) return;
      const m = bodyBase(TIMING_SLOTS.marks + round);
      mesh.visible = ((state[m + BODY.flags] as number) & FLAG.alive) !== 0;
      const w = (state[m + BODY.w] as number) / UNIT;
      mesh.scale.x = w;
      mesh.position.set(-(state[m + BODY.x] as number) / UNIT, (state[m + BODY.y] as number) / UNIT + TIMING.blockH / UNIT / 2, 0);
    });
    // Trefa = jezdec i právě položený díl poskočí, minutí = zakymácejí se, výhra = vrchní díl slaví (jezdec už je schovaný).
    const pose = beatPoseOf(state, prev, toyPose.current, toyTickOf(session), !toyMotionOn());
    toyPose.current = pose;
    const pieceH = TIMING.blockH / UNIT;
    if (sliderPose.current !== null) applyToy({ group: sliderPose.current }, pose, pieceH);
    const newest = Math.floor((state[bodyBase(state[HEADER.player] as number) + BODY.z] as number) / UNIT) - 1;
    if (posedRound.current !== newest) {
      const was = placedPoses.current[posedRound.current];
      if (was !== null && was !== undefined) standStill(was);
      posedRound.current = newest;
    }
    const topPiece = placedPoses.current[newest];
    if (topPiece !== null && topPiece !== undefined) applyToy({ group: topPiece }, pose, pieceH);
    const y = (state[s + BODY.y] as number) / UNIT;
    followY.current = followY.current === null ? y : lerp(followY.current, y, Math.min(1, delta * 3));
    // Vidět celý kyv (±amplituda + blok) i na výšku: vzdálenost z poměru stran.
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const dist = Math.max(10 / (2 * tan * camera.aspect), 7 / (2 * tan), 8);
    // Na výšku je kamera daleko a díl by měl pod 4 % výšky obrazu: víc shora je vidět i jeho
    // vršek, takže je na snímku vyšší a pozná se (P30B T5).
    camera.position.set(0, followY.current + (camera.aspect < 1 ? 3.5 : 1.5), -dist);
    look.set(0, followY.current, 0);
    camera.lookAt(look);
  });

  const depth = TIMING.depth / UNIT;
  const blockH = TIMING.blockH / UNIT;
  return (
    <>
      {/* Obloha, mlha, světla a stíny jsou rigu (`look/rig/StyleRig.tsx`, P32A T10). */}
      {/* Zem a základna (věž stojí na ní, můstek začíná sloupem, lišta je deska). Zem s odstíny a skvrnami až pod kulisy a do mlhy (P46G T7). */}
      <FieldGround look={scene} area={TIMING_LAND} y={-0.005} under />
      {/* Kulisy sady prostředí (P27A T4) v řadě za hrací plochou: otočená sada „behind“ jde přes x v hloubce +z. */}
      <group rotation={[0, -Math.PI / 2, 0]}>
        <Scenery look={scene} layout="behind" inner={SCENERY_BEHIND} from={-14} to={14} />
      </group>
      {/* Kulisa za mlhou (P46G T7) za řadou kulis; vegetace ne – plocha je jen věž a kyv jezdce. */}
      <HorizonBackdrop look={scene} seed={world.seed} clear={0} beyond={BACKDROP_BEYOND} />
      <Landmark look={scene} seed={world.seed} area={TIMING_AREA} />
      <mesh position={[0, base.h / 2, 0]}>
        <boxGeometry args={[base.w, base.h, depth]} />
        <meshStandardMaterial color={BASE_COLOR[baseKind] ?? '#475569'} roughness={0.8} />
      </mesh>
      {/* Tolerance: průsvitný sloupec nad středem – kam jezdce zastavit. */}
      {/* Pro sondu záběru (P27A T6) je tolerance cíl a jezdec hrdina. */}
      <mesh position={[-target.x, top / 2 + 0.5, -depth / 2 - 0.02]} userData={{ frame: 'target' }}>
        <boxGeometry args={[target.w, top + 1, 0.02]} />
        <meshBasicMaterial color="#16a34a" transparent opacity={0.28} />
      </mesh>
      {/* Položený díl má jednotkovou šířku a `scale.x` mu dá šířku z jádra; díl stojí na zemi, proto o půl výšky níž. */}
      {/* Vnitřní skupina pózy (P45D T11) má počátek u paty dílu, ať se díl při dopadu zmáčkne na díl pod sebou. */}
      {Array.from({ length: marks }, (_, round) => (
        <group key={round} ref={(group) => { placed.current[round] = group; }} visible={false} userData={{ item: sliderKind === 'block' ? 'block' : undefined }}>
          <group position={[0, -blockH / 2, 0]}>
            <group ref={(group) => { placedPoses.current[round] = group; }}>
              {blocks !== undefined ? (
                blocks(1, blockH, depth)
              ) : (
                <mesh position={[0, blockH / 2, 0]}>
                  <boxGeometry args={[1, blockH, depth]} />
                  <meshStandardMaterial color={MARK_COLORS[round % MARK_COLORS.length]} roughness={0.6} />
                </mesh>
              )}
            </group>
          </group>
        </group>
      ))}
      {/* Jezdec věže je zároveň díl z věty (P30B T5, `item`), sonda ho počítá i jako položku. */}
      {/* Kyv jede po vnější skupině, hračková póza (P45D T11) po vnitřní. */}
      <group ref={slider} userData={{ frame: 'hero', item: sliderKind === 'block' ? 'block' : undefined }}>
        <group ref={sliderPose}>
          {blocks !== undefined ? (
            blocks(sliderInit.w, blockH, depth)
          ) : (
            <mesh position={[0, blockH / 2, 0]}>
              <boxGeometry args={[sliderInit.w, blockH, depth]} />
              <meshStandardMaterial color={SLIDER_COLOR[sliderKind] ?? '#f59e0b'} roughness={0.5} />
            </mesh>
          )}
        </group>
      </group>
      {/* Slot ducha (P37-0 T3) vedle jezdce, ne v jeho skupině. */}
      <GhostSlot ghost={ghost} session={session} place={ghostSpot} />
    </>
  );
}
