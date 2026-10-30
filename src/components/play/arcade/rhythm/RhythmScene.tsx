'use client';

import { renderHeld } from '../effects/render-feel';

/**
 * Scéna rytmu (P25H T5): čtyři pruhy, noty jedou ke kameře a ťuká se, když
 * přejíždějí lištu. Rytmus jde přečíst i bez zvuku – lišta se rozsvítí,
 * když je nota v okně, trefa bliká zeleně, minutí červeně.
 *
 * Zvuk je ozdoba mimo stav: krátké pípnutí, když nota dorazí na lištu
 * (beat), a vyšší tón při trefě. Kontext, probuzení gestem a ztlumení M
 * jsou společné všem hrám (`@/play/audio`, P28C T2). Nic z toho nesahá do
 * relace ani do hashe.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Group, MeshStandardMaterial, PerspectiveCamera } from 'three';
import { Box3, Vector3 } from 'three';

import { baseControlOf } from '@/play/arcade/addons';
import { BODY, FLAG, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { RHYTHM } from '@/play/arcade/pieces/rhythm';
import type { ToyPose } from '@/play/arcade/toy-motion';
import type { HeroAction } from '@/play/spec';
import { playTone } from '@/play/audio';

import { type ArcadeGhost, GhostSlot, besideHero } from '../GhostSlot';
import { HorizonBackdrop } from '../look/Backdrop';
import { FieldGround } from '../look/FieldGround';
import type { Box } from '../look/ground';
import { Landmark } from '../look/Landmark';
import type { Volume } from '../look/landmark-places';
import { Scenery } from '../look/Scenery';
import { fitTall, usePlayRectRef } from '../portrait-frame';
import type { ArcadeSession } from '../session';
import { type BodyModel, beatPoseOf, initialBody } from '../timing/TimingScene';
import { applyToy, toyMotionOn, toyTickOf } from '../toy/applyToy';

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;

// Barva pruhu zleva doprava; nic fialového.
const LANE_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#0ea5e9'];
const LANE_OF = (x: number): number => Math.round(x / RHYTHM.laneW + (RHYTHM.lanes - 1) / 2);
const FLASH_TICKS = 12;
const TRACK_M = 60;
/** Zem rytmu (m): do stran za kulisy, dozadu přes konec pruhů. */
const RHYTHM_LAND = { x0: -30, x1: 30, z0: -10, z1: TRACK_M + 20 } as const;
/** Nejbližší vrstva kulisy (m od kamery 4,5+ m před lištou): za koncem pruhů. */
const BACKDROP_BEYOND = TRACK_M + 12;
/** Pruhy, po kterých jedou noty z 60 m: orientační bod a rámující kusy stojí vedle nich (P54B T8). */
const LANES_AREA: readonly Box[] = [{ x0: -(RHYTHM.lanes * RHYTHM.laneW) / UNIT / 2 - 1, x1: (RHYTHM.lanes * RHYTHM.laneW) / UNIT / 2 + 1, z0: -3, z1: TRACK_M }];
/** Pruhy s notami, které teprve přijedou (P54B T15a): bod ani kus se s nimi v obraze nepotká. */
const LANES_PLAY: readonly Volume[] = [{ x0: -(RHYTHM.lanes * RHYTHM.laneW) / UNIT / 2, y0: 0, z0: -2, x1: (RHYTHM.lanes * RHYTHM.laneW) / UNIT / 2, y1: 0.5, z1: TRACK_M }];
const HERO_M = { w: 0.8, h: 1.5, d: 0.6 };
const HERO_GAP_M = 0.7;
const HERO_Z_M = 0.6;
/**
 * Na výšku (P64 T4, `fitTall`): strměji (`pitch`) na bod `look` m za lištou, lišta s `side` m po stranách vyplní šířku
 * plátna a pruhy `ahead` m před ní se vejdou do `playRect` pod HUD – pruhy běží nahoru po obrazovce až k obzoru. Bod
 * pohledu na 9 m (šířka) by lištu na iPhonu stlačil ke spodní hraně a kamera by kvůli ní couvla (lišta 0,107 místo
 * 0,136 plochy).
 */
const TALL = { side: 0.2, ahead: 8, pitch: (24 * Math.PI) / 180, look: 7 } as const;

/** Hranice mezi pruhy (0|1, 1|2, 2|3) v `x` noty, jednotky jádra; kreslí se zrcadlově (`-x`). */
const LANE_EDGES = Array.from({ length: RHYTHM.lanes - 1 }, (_, i) => (i + 1 - RHYTHM.lanes / 2) * RHYTHM.laneW);

/**
 * `noteModel` (P30B T4): nota z popisku role `note` („lily pads“) na svítící desce v barvě pruhu.
 * `surface` (P36A T11): plocha, které scéna zapíše hranice pruhů u lišty (`data-lane-edges`) – z nich ťuk pozná dráhu.
 */
export function RhythmScene({
  session,
  look: scene,
  heroModel,
  noteModel,
  surface,
  ghost,
}: {
  readonly session: ArcadeSession;
  readonly look: Look;
  /** P43 T14b: hrdina z popisku („grandma“) stojí vedle pruhů naproti duchovi, čelem ke kameře; noty nezakryje. */
  readonly heroModel?: BodyModel;
  readonly noteModel?: BodyModel;
  readonly surface?: React.RefObject<HTMLDivElement | null>;
  readonly heroAction: HeroAction;
  readonly ghost?: ArcadeGhost;
}) {
  const world = session.world;
  const count = world.initial[HEADER.bodyCount] as number;
  const notes = useMemo(() => Array.from({ length: count - 1 }, (_, i) => initialBody(world, i + 1)), [world, count]);
  const bar = initialBody(world, 0);
  // Duch stojí vedle lišty (hráčovo `z` jsou noty, ne dráha).
  const ghostSpot = useMemo(() => besideHero(0, 0, bar.w / 2, 'x'), [bar.w]);
  const groups = useRef<(Group | null)[]>([]);
  const barMaterial = useRef<MeshStandardMaterial | null>(null);
  const flash = useRef<{ tick: number; hit: boolean } | null>(null);
  // Hračková póza hrdiny (P45D T11): vnitřní skupina modelu a póza minulého snímku.
  const heroPose = useRef<Group | null>(null);
  const toyPose = useRef<ToyPose | null>(null);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look = useMemo(() => new Vector3(0, 0, 9), []);
  const edge = useMemo(() => new Vector3(), []);
  const lanes = useMemo(() => new Box3(), []);
  const atBar = useMemo(() => new Box3(), []);
  const playArea = usePlayRectRef();
  // Okno čte základní ovládání: nad průběhem (P45C T14) je ovládání světa `pacing_control`.
  const hitWindow = (baseControlOf(world.control).params as { window?: number }).window ?? RHYTHM.window;
  const reach = hitWindow * RHYTHM.noteSpeed;

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const tick = state[HEADER.tick] as number;
    let near = false;
    notes.forEach((_, i) => {
      const group = groups.current[i];
      if (group === null || group === undefined) return;
      const at = bodyBase(i + 1);
      const z = state[at + BODY.z] as number;
      const before = prev[at + BODY.z] as number;
      const alive = ((state[at + BODY.flags] as number) & FLAG.alive) !== 0;
      group.visible = alive && z / UNIT < TRACK_M;
      group.position.z = lerp(before, z, alpha) / UNIT;
      if (alive && Math.abs(z) <= reach) near = true;
      // Beat: nota právě přejela lištu (z kladného na nekladné).
      if (before > 0 && z <= 0 && tick !== 0) playTone(440, 0.05);
    });
    const p = bodyBase(state[HEADER.player] as number);
    const result = state[p + BODY.aux0] as number;
    if (result !== 0 && flash.current?.tick !== tick) {
      flash.current = { tick, hit: result > 0 };
      if (result > 0) playTone(880, 0.08);
    }
    const material = barMaterial.current;
    if (material !== null) {
      const recent = flash.current !== null && tick - flash.current.tick < FLASH_TICKS ? flash.current : null;
      material.color.set(recent !== null ? (recent.hit ? '#22c55e' : '#dc2626') : near ? '#fde047' : '#e2e8f0');
      material.emissive.set(recent !== null || near ? material.color : '#000000');
      material.emissiveIntensity = recent !== null ? 0.8 : near ? 0.4 : 0;
    }
    // Trefa = poskok se zmáčknutím, minutí = zakymácení, výhra = oslava; do taktu se hrdina sám nehýbe.
    const hero = heroPose.current;
    if (hero !== null) {
      const pose = beatPoseOf(state, prev, toyPose.current, toyTickOf(session), !toyMotionOn());
      toyPose.current = pose;
      applyToy({ group: hero }, pose, HERO_M.h);
    }
    const rect = playArea.current;
    if (camera.aspect < 1 && rect !== null) {
      // Na výšku (P64 T4): strmější pohled, lišta se všemi pruhy přes šířku plátna, pruhy před ní nahoru po obrazovce.
      // Výchozí vzdálenost je jedno – `fitTall` kameru posune po ose pohledu, kam má být.
      camera.position.set(0, 10 * Math.sin(TALL.pitch), TALL.look - 10 * Math.cos(TALL.pitch));
      camera.lookAt(0, 0, TALL.look);
      const half = bar.w / 2 + TALL.side;
      lanes.min.set(-half, 0, -bar.d / 2 - TALL.side);
      lanes.max.set(half, bar.h, TALL.ahead);
      atBar.min.set(-half, 0, -bar.d / 2);
      atBar.max.set(half, bar.h, bar.d / 2);
      camera.position.copy(fitTall(camera, lanes, rect, { keep: atBar }).position);
    } else {
      // Bez změřeného `playRect` (a na mobilu dřív) kamera na výšku ustoupí a zvedne se, ať jsou vidět všechny čtyři pruhy u lišty.
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const back = Math.max(4.5, (bar.w + 0.8) / (2 * tan * camera.aspect) - 1);
      camera.position.set(0, 3.2 * (back / 4.5), -back);
      camera.lookAt(look);
    }
    const host = surface?.current;
    if (host != null) {
      camera.updateMatrixWorld();
      const edges = LANE_EDGES.map((x) => ((edge.set(-x / UNIT, 0, 0).project(camera).x + 1) / 2).toFixed(4)).join(',');
      if (host.dataset.laneEdges !== edges) host.dataset.laneEdges = edges;
    }
  });

  const laneW = RHYTHM.laneW / UNIT;
  return (
    <>
      {/* Obloha, mlha, světla a stíny jsou rigu (`look/rig/StyleRig.tsx`, P32A T10); tma zůstává jen pod pruhy. */}
      {/* Prostředí (P27A T4): zem sady kolem pruhů a kulisy po stranách; pod pruhy zůstává tma, ať svítící noty čtou. */}
      {/* Zem s odstíny a skvrnami (P46G T7) místo jedné barvy sady; vegetace ne – pruhy vedou do dálky a ty se nesmí zakrýt. */}
      <FieldGround look={scene} area={RHYTHM_LAND} y={-0.06} under />
      {/* Kulisa za mlhou až za koncem pruhů: noty jedou z 60 m. */}
      <HorizonBackdrop look={scene} seed={session.world.seed} clear={0} beyond={BACKDROP_BEYOND} />
      <Landmark look={scene} seed={session.world.seed} area={LANES_AREA} play={LANES_PLAY} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.04, TRACK_M / 2 - 2]}>
        <planeGeometry args={[RHYTHM.lanes * laneW + 0.4, TRACK_M]} />
        <meshStandardMaterial color="#0f172a" roughness={1} />
      </mesh>
      <Scenery look={scene} layout="sides" inner={(RHYTHM.lanes * laneW) / 2 + 2} from={2} to={TRACK_M} />
      {LANE_COLORS.map((color, lane) => (
        <mesh key={color} rotation={[-Math.PI / 2, 0, 0]} position={[-(lane - (RHYTHM.lanes - 1) / 2) * laneW, -0.02, TRACK_M / 2 - 2]}>
          <planeGeometry args={[laneW * 0.94, TRACK_M]} />
          <meshStandardMaterial color={color} transparent opacity={0.18} />
        </mesh>
      ))}
      {/* Rytmus nemá postavu: hrdinou sondy záběru (P27A T6) je lišta, na kterou hráč ťuká, cílem noty. */}
      <mesh position={[0, bar.h / 2, 0]} userData={{ frame: 'hero' }}>
        <boxGeometry args={[bar.w, bar.h, bar.d]} />
        <meshStandardMaterial ref={barMaterial} color="#e2e8f0" />
      </mesh>
      {heroModel !== undefined && (
        <group position={[-(bar.w / 2 + HERO_GAP_M), 0, HERO_Z_M]} rotation={[0, Math.PI, 0]}>
          {/* Hrdinou sondy je lišta; hračkovou pózu postavy čte `heroToy` sondy (P45D T14). */}
          <group ref={heroPose} userData={{ toyHero: true }}>{heroModel(HERO_M.w, HERO_M.h, HERO_M.d)}</group>
        </group>
      )}
      {/* Slot ducha (P37-0 T3) vedle lišty. */}
      <GhostSlot ghost={ghost} session={session} place={ghostSpot} />
      {notes.map((note, i) => {
        const lane = LANE_OF(note.x * UNIT);
        return (
          <group key={i} ref={(group) => { groups.current[i] = group; }} position={[-note.x, 0, note.z]} userData={{ frame: 'target', item: 'note' }}>
            {noteModel !== undefined ? (
              <>
                <mesh position={[0, 0.02, 0]}>
                  <boxGeometry args={[note.w, 0.04, note.d]} />
                  <meshStandardMaterial color={LANE_COLORS[lane] ?? '#f59e0b'} emissive={LANE_COLORS[lane] ?? '#f59e0b'} emissiveIntensity={0.35} />
                </mesh>
                <group position={[0, 0.04, 0]}>{noteModel(note.w, note.h, note.d)}</group>
              </>
            ) : (
              <mesh position={[0, note.h / 2, 0]}>
                <boxGeometry args={[note.w, note.h, note.d]} />
                <meshStandardMaterial color={LANE_COLORS[lane] ?? '#f59e0b'} emissive={LANE_COLORS[lane] ?? '#f59e0b'} emissiveIntensity={0.35} />
              </mesh>
            )}
          </group>
        );
      })}
    </>
  );
}
