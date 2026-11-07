'use client';

/**
 * Scéna minigolfu (P68 T8, kategorie `vozidla-sport`): jedna jamka z dlaždic s mantinely v místě z věty. Dráha je
 * trávník kitu, mantinely, jamka (procedurální kalíšek – katalog jamku nemá) s vlajkou `finish-flag`, odrazníky
 * a pohyblivá překážka jako věci z věty (`modelIdOf` – model druhu těla, popisek role `barrier` / `obstacle`),
 * kolem ostrůvek s vegetací sady (`minigolfDressing`, P73D), kulisy a horizont sady (`look`). Míček je hráč,
 * kutálí se po stavu jádra – kreslí ho scéna jako kouli: model `gen3d-golf-ball` má odlitý týček s trávníkem
 * a kutálel se s ním.
 *
 * **Kamera** za míčkem po ose z míčku na cíl trasy (`minigolf-camera.ts`, míření ji nehýbe), tlumený přechod mezi klidem
 * a sledováním; na výšku přes `usePlayRectRef` + `fitTall`. **Natažení** dělá DOM vrstva `MinigolfTouch` – registr
 * `GENRE_TOUCH` montuje jen vstup `genre`, minigolf má `throw-rig`, pro který `ArcadeStage` na plátně nic nemá, takže
 * ji scéna sama připojí do kontejneru plátna (`surface`) vlastním kořenem Reactu.
 *
 * Jen obraz, mimo stav i hash: stopa míření na trávníku (délka podle nabití), valení míčku, tlumení kamery. x jádra
 * se zrcadlí jako v aréně (kamera kouká po +z, +x je vpravo), takže kladná osa míří na obrazovce doprava.
 *
 * **Volání kreslení** (P68-L T3): trávník, mantinely, sokly odrazníků a stopa míření jsou každé jedna síť – po kusech
 * stála scéna na Pixelu 7 (CPU ×4) 85 volání kreslení snímku (barva i stín) proti 44 her, které `main` pro tytéž věty
 * hraje. Rovné kusy dráhy (trávník, kalíšek s okrajem) stín jen přijímají. Před prvním vstupem kamera přeměřený hrací
 * obdélník přeskočí jedním snímkem (`minigolfCameraStep`, `hold`).
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { type BufferAttribute, BoxGeometry, type BufferGeometry, CircleGeometry, Float32BufferAttribute, type Group, type Mesh, type PerspectiveCamera, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { color, colorHex } from '@/brand/tokens';
import { baseControlOf } from '@/play/arcade/addons';
import { BODY, HEADER, RUN_STATE, UNIT, bodyBase } from '@/play/arcade/contract';
import { type Flora, type Look, markedFlora } from '@/play/arcade/look';
import { strokesOf } from '@/play/arcade/pieces/minigolf';
import { minigolfLayout } from '@/play/arcade/pieces/minigolf-hole';
import { MINIGOLF, minigolfAim, minigolfDistance } from '@/play/arcade/pieces/minigolf-roll';

import { renderHeld } from '../../effects/render-feel';
import { worldPlacement } from '../../Ghost';
import { GhostSlot } from '../../GhostSlot';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import type { Box as GroundBox } from '../../look/ground';
import { Scenery } from '../../look/Scenery';
import { VegetationAround } from '../../look/Vegetation';
import type { Layer, Side } from '../../look/vegetation-places';
import { type PlayRect, playRect as playRectOf, usePlayRectRef } from '../../portrait-frame';
import { FittedModel, type WorldProps, modelIdOf } from '../../World';
import { type MinigolfCourseView, minigolfCameraPose, minigolfCameraRig, minigolfCameraStep, minigolfCourseView } from './minigolf-camera';
import { MinigolfTouch } from './MinigolfTouch';

const m = (units: number): number => units / UNIT;
const BALL_M = m(MINIGOLF.ball);
const CUP_M = m(MINIGOLF.holeSize) / 2;
/** Vlajka v jamce (m). */
const FLAG = { w: 0.55, h: 1.6, d: 0.12 } as const;
/**
 * Stopa míření: tečky na trávníku; bez nabití krátká, s nabitím do `max` m podle dojezdu rány. Tečka `k` má neprůhlednost
 * `alpha − k · fade` (slábne ke špičce), leží `y` m nad trávníkem.
 */
const TRAIL = { dots: 10, idle: 1.2, max: 5, radius: 0.05, segments: 12, y: 0.02, alpha: 0.95, fade: 0.07 } as const;
/** Skok míčku dál než tohle (m) mezi tiky = návrat z mimo dráhy, ne pohyb. */
const JUMP = 2;
/** Tloušťka trávníku pod nulou a výška soklu odrazníku (m). */
const GREEN_H = 0.1;
const PLINTH_H = 0.06;
/**
 * Podstavec diorama kolem dráhy (m, P73D): ostrůvek s hranou v záběru před mlhou. Dřív 30 m holé roviny, která
 * v mlze vypadala nekonečná; vegetace i kulisy stojí uvnitř (`land` ve `VegetationAround`).
 */
const AROUND = 20;
/** Volný trávník mezi obalem dráhy a vegetací (m): míček, který mantinel přeskočí, nedopadne do keře. */
const DRESSING_CLEAR = 2.5;
const ALL_LAYERS: readonly Layer[] = ['near', 'mid', 'far'];
/** Mezera mezi úvodní kartou a lištou HUD i hřištěm (px, `--sp-space-4` jako `PROMPT_GAP_PX` plátna). */
const CARD_GAP_PX = 16;

/**
 * Úvodní karta přisazená nahoru (P71C T2): kartu plátno staví nad míček nebo pod něj, jenže dráha vede od míčku
 * nahoru k cíli a karta nad míčkem ji zakryla. Dokud karta visí (tik 0, čeká se na první vstup), sedí pod horní lištou
 * HUD (`data-prompt-dock`, `--_prompt-top` v `play.css`) a vrátí plochu pod sebou, do které kamera rámuje hřiště.
 */
function startArea(host: HTMLElement | null, rect: PlayRect | null): PlayRect | null {
  const card = host?.querySelector<HTMLElement>('.play-first-prompt') ?? null;
  if (host === null || card === null || rect === null) return null;
  const top = rect.px.top + CARD_GAP_PX;
  const value = `${String(Math.round(top))}px`;
  if (host.style.getPropertyValue('--_prompt-top') !== value) host.style.setProperty('--_prompt-top', value);
  return playRectOf(rect.canvas, top + card.offsetHeight + CARD_GAP_PX, rect.px.bottom);
}

/** Přisazení karty nahoru platí, dokud je scéna minigolfu na plátně. */
function useDockedCard(surface: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const host = surface.current;
    if (host === null) return;
    host.dataset.promptDock = 'top';
    return () => {
      delete host.dataset.promptDock;
      host.style.removeProperty('--_prompt-top');
    };
  }, [surface]);
}

type MinigolfSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

interface Piece {
  readonly index: number;
  /** Střed (scéna, m; x zrcadlené), spodek `y` a rozměry. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly model: string;
}

interface Course {
  readonly view: MinigolfCourseView;
  readonly hole: Piece;
  readonly floor: readonly Piece[];
  readonly rails: readonly Piece[];
  readonly bumpers: readonly Piece[];
  readonly mover: Piece | null;
  /** Obal dráhy ve scéně (m). */
  readonly bounds: GroundBox;
}

/** Dlaždice jádra (jednotky) ve scéně: střed v m, x zrcadlené. */
const tileBox = (tile: MinigolfCourseView['floor'][number]): GroundBox => {
  const [x, z, w, d] = [-m(tile.x), m(tile.z), m(tile.w), m(tile.d)];
  return { x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 };
};

/** Obal dlaždic dráhy ve scéně (m). */
function courseBounds(view: MinigolfCourseView): GroundBox {
  const tiles = view.floor.map(tileBox);
  return {
    x0: Math.min(...tiles.map((tile) => tile.x0)),
    x1: Math.max(...tiles.map((tile) => tile.x1)),
    z0: Math.min(...tiles.map((tile) => tile.z0)),
    z1: Math.max(...tiles.map((tile) => tile.z1)),
  };
}

export interface MinigolfDressing {
  /** Obal dráhy (m, scéna) – vegetace stojí za ním a za volným pásem `clear`. */
  readonly box: GroundBox;
  readonly clear: number;
  /** Podstavec (`FieldGround`) a zem, za jejíž hranu nic nesahá. */
  readonly land: GroundBox;
  /** Vegetace sady, v cukrové zemi z věty i s lízátky (`markedFlora`); sada bez vegetace nic. */
  readonly flora: Flora | undefined;
  readonly layers: Readonly<Record<Side, readonly Layer[]>>;
}

/**
 * Svět kolem jamky (P73D): podstavec, na něm vegetace sady (`VegetationAround`) mimo dráhu a volný trávník kolem ní.
 * Strany podle kamery (`minigolf-camera.ts` – vždy za míčkem, na cíl trasy): za odpalištěm (−z) stojí kamera prvního
 * úseku, tam nic. Jamka s rohem (L, S) má úsek napříč (`floor[0]` je odpaliště, `[0, 0]`); kamera toho úseku stojí na
 * straně proti němu, tam jen nízké drobnosti, přes které vidí na míček. Jinde všechny vrstvy – stromy rámují dráhu.
 */
export function minigolfDressing(view: MinigolfCourseView, look: Pick<Look, 'flora' | 'skyline'>): MinigolfDressing {
  const box = courseBounds(view);
  const tee = tileBox(view.floor[0]!);
  // Polovina dlaždice jako rezerva: obal napříč přesahuje odpaliště o celé dlaždice.
  const slack = (tee.x1 - tee.x0) / 2;
  const across: Side | null = box.x1 > tee.x1 + slack ? '+x' : box.x0 < tee.x0 - slack ? '-x' : null;
  const side = (key: Side): readonly Layer[] => (across !== null && key !== across ? ['near'] : ALL_LAYERS);
  return {
    box,
    clear: DRESSING_CLEAR,
    land: { x0: box.x0 - AROUND, x1: box.x1 + AROUND, z0: box.z0 - AROUND, z1: box.z1 + AROUND },
    flora: markedFlora(look),
    layers: { '-z': [], '+z': ALL_LAYERS, '-x': side('-x'), '+x': side('+x') },
  };
}

/** Těla hřiště z počátečního stavu světa a rozložení z parametrů ovládání. */
function courseOf(world: MinigolfSceneProps['session']['world'], cast: MinigolfSceneProps['cast']): Course {
  const layout = minigolfLayout.parse(baseControlOf(world.control).params.layout);
  const initial = world.initial;
  const piece = (index: number): Piece => {
    const at = (slot: number): number => initial[bodyBase(index) + slot] as number;
    const kind = world.kinds[at(BODY.kind)] ?? '';
    const size = { w: m(at(BODY.w)), h: m(at(BODY.h)), d: m(at(BODY.d)) };
    return { index, x: -m(at(BODY.x)), y: m(at(BODY.y)), z: m(at(BODY.z)), ...size, model: modelIdOf({ index, kind, role: at(BODY.role), ...size }, cast) };
  };
  const range = ([first, count]: readonly [number, number]): Piece[] => Array.from({ length: count }, (_, k) => piece(first + k));
  const view = minigolfCourseView(initial, layout);
  return {
    view,
    hole: piece(layout.hole),
    floor: range(layout.floor),
    rails: range(layout.rails),
    bumpers: range(layout.bumpers),
    mover: layout.mover === undefined ? null : piece(layout.mover),
    bounds: courseBounds(view),
  };
}

type Box = Pick<Piece, 'x' | 'y' | 'z' | 'w' | 'h' | 'd'>;

/** Kvádry (střed `x/z`, spodek `y`, m) jako jedna geometrie; prázdný seznam nic. */
function boxesGeometry(boxes: readonly Box[]): BufferGeometry | null {
  if (boxes.length === 0) return null;
  const parts = boxes.map((box) => new BoxGeometry(box.w, box.h, box.d).translate(box.x, box.y + box.h / 2, box.z));
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged;
}

/**
 * Stopa míření jako jedna geometrie: `TRAIL.dots` teček v rovině trávníku, slábnutí ke špičce v alfě barvy vrcholů.
 * Polohy vrcholů píše `placeTrail`; `dot` = vrcholy jedné tečky kolem počátku (x, y, z za sebou).
 */
function trailGeometry(): { readonly geometry: BufferGeometry; readonly dot: Float32Array } {
  const dot = new CircleGeometry(TRAIL.radius, TRAIL.segments).rotateX(-Math.PI / 2);
  const parts = Array.from({ length: TRAIL.dots }, (_, k) => {
    const part = dot.clone();
    const alpha = TRAIL.alpha - k * TRAIL.fade;
    part.setAttribute('color', new Float32BufferAttribute(Array.from({ length: part.getAttribute('position').count }, () => [1, 1, 1, alpha]).flat(), 4));
    return part;
  });
  const geometry = mergeGeometries(parts);
  const offsets = Float32Array.from(dot.getAttribute('position').array);
  for (const part of [dot, ...parts]) part.dispose();
  return { geometry, dot: offsets };
}

/** Tečka `k` leží `BALL_M + (k + 1) · reach / dots` m od míčku `at` ve směru (`dx`, `dz`) – jednotkový, scéna. */
function placeTrail(position: BufferAttribute, dot: Float32Array, at: { readonly x: number; readonly z: number }, dx: number, dz: number, reach: number): void {
  const per = dot.length / 3;
  for (let k = 0; k < TRAIL.dots; k += 1) {
    const along = BALL_M + ((k + 1) * reach) / TRAIL.dots;
    const cx = at.x + dx * along;
    const cz = at.z + dz * along;
    for (let v = 0; v < per; v += 1) position.setXYZ(k * per + v, cx + (dot[3 * v] as number), TRAIL.y + (dot[3 * v + 1] as number), cz + (dot[3 * v + 2] as number));
  }
  position.needsUpdate = true;
}

/** Sokl odrazníku: nízký kvádr v půdorysu těla, kde se míček odrazí (u odrazníků jedna síť, `boxesGeometry`). */
const plinthOf = (piece: Piece): Box => ({ x: piece.x, y: 0, z: piece.z, w: piece.w, h: PLINTH_H, d: piece.d });

/** Věc z věty na hřišti: model vepsaný do těla (sokl kreslí scéna). */
function Obstacle({ piece }: { readonly piece: Piece }) {
  return <FittedModel id={piece.model} w={piece.w} h={piece.h} d={piece.d} fallback={color.tomato} />;
}

/** DOM vrstva natažení v kontejneru plátna: vlastní kořen Reactu, ať jde i ze stromu plátna (a tunelem feedu). */
function useTouchLayer(surface: React.RefObject<HTMLDivElement | null>, session: MinigolfSceneProps['session'], enabled: boolean): void {
  useEffect(() => {
    const host = surface.current;
    if (!enabled || host === null) return;
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;inset:0';
    host.appendChild(holder);
    const root = createRoot(holder);
    root.render(<MinigolfTouch session={session} />);
    return () => {
      holder.remove();
      // Mimo průchod usmíření plátna: synchronní odpojení kořene uprostřed renderu React hlásí jako chybu.
      window.setTimeout(() => root.unmount(), 0);
    };
  }, [surface, session, enabled]);
}

export function MinigolfScene({ session, cast, surface, scene: look, enabled, ghost }: MinigolfSceneProps) {
  const world = session.world;
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const course = useMemo(() => courseOf(world, cast), [world, cast]);
  const dressing = useMemo(() => minigolfDressing(course.view, look), [course, look]);
  const playRect = usePlayRectRef();
  useTouchLayer(surface, session, enabled);
  useDockedCard(surface);

  const ball = useRef<Group | null>(null);
  const spin = useRef<Group | null>(null);
  const mover = useRef<Group | null>(null);
  const trailMesh = useRef<Mesh | null>(null);
  /** `trail` = poslední zapsaná stopa (x, z míčku, směr, dosah) – vrcholy se přepíšou, jen když se změní. */
  const memory = useRef<{ at: Vector3 | null; trail: number[] }>({ at: null, trail: [] });
  const rig = useMemo(minigolfCameraRig, []);
  /** Stav pro kameru s míčkem tam, kde je nakreslený (interpolace mezi tiky) – jinak by kamera jela po tikách. */
  const drawn = useRef<Int32Array>(new Int32Array(0));
  /** Plocha pod úvodní kartou (`startArea`), do které se rámuje přehled až do první rány. */
  const startFrame = useRef<PlayRect | null>(null);
  const scratch = useMemo(() => ({ axis: new Vector3(), step: new Vector3() }), []);
  const boxes = useMemo(
    () => ({
      green: boxesGeometry(course.floor.map((tile) => ({ ...tile, y: -GREEN_H, h: GREEN_H }))),
      rails: boxesGeometry(course.rails),
      plinths: boxesGeometry(course.bumpers.map(plinthOf)),
    }),
    [course],
  );
  useEffect(
    () => () => {
      for (const geometry of Object.values(boxes)) geometry?.dispose();
    },
    [boxes],
  );
  const trail = useMemo(trailGeometry, []);
  useEffect(() => () => trail.geometry.dispose(), [trail]);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    /** Poloha těla ve scéně (m), interpolovaná; skok (návrat z mimo dráhy) se neinterpoluje. */
    const place = (body: number): { x: number; z: number } => {
      const base = bodyBase(body);
      const nx = state[base + BODY.x] as number;
      const nz = state[base + BODY.z] as number;
      const px = prev[base + BODY.x] as number;
      const pz = prev[base + BODY.z] as number;
      return Math.hypot(m(nx - px), m(nz - pz)) > JUMP ? { x: -m(nx), z: m(nz) } : { x: -m(px + (nx - px) * alpha), z: m(pz + (nz - pz) * alpha) };
    };

    // Míček: valí se po trávníku (natočení podle ujeté dráhy), po výhře sedí v kalíšku.
    const player = state[HEADER.player] as number;
    const p = bodyBase(player);
    const won = state[HEADER.runState] === RUN_STATE.won;
    const at = won ? { x: course.hole.x, z: course.hole.z } : place(player);
    const group = ball.current;
    if (group !== null) {
      const last = memory.current.at;
      if (last !== null && spin.current !== null) {
        scratch.step.set(at.x - last.x, 0, at.z - last.z);
        const length = scratch.step.length();
        if (length > 1e-4 && length < JUMP) spin.current.rotateOnWorldAxis(scratch.axis.set(scratch.step.z, 0, -scratch.step.x).normalize(), length / (BALL_M / 2));
      }
      memory.current.at = (memory.current.at ?? new Vector3()).set(at.x, 0, at.z);
      // V jamce napůl pod okrajem kalíšku.
      group.position.set(at.x, won ? -BALL_M / 2 : 0, at.z);
    }

    // Pohyblivá překážka: kyvadlo jádra.
    if (course.mover !== null && mover.current !== null) {
      const there = place(course.mover.index);
      mover.current.position.set(there.x, 0, there.z);
    }

    // Stopa míření: ze stavu (osa, nabití), jen když míček stojí a hra běží.
    const resting = (state[p + BODY.vx] as number) === 0 && (state[p + BODY.vz] as number) === 0;
    const showTrail = !won && state[HEADER.runState] === RUN_STATE.running && resting;
    const [ax, az] = minigolfAim(state[p + BODY.aux0] as number);
    const length = Math.hypot(ax, az);
    const charge = Math.max(0, state[p + BODY.aux1] as number);
    const reach = charge > 0 ? Math.min(TRAIL.max, m(minigolfDistance(charge))) : TRAIL.idle;
    const dots = trailMesh.current;
    if (dots !== null) {
      dots.visible = showTrail;
      const next = [at.x, at.z, -ax / length, az / length, reach];
      const last = memory.current.trail;
      if (showTrail && next.some((value, k) => value !== last[k])) {
        placeTrail(dots.geometry.getAttribute('position') as BufferAttribute, trail.dot, at, next[2] as number, next[3] as number, reach);
        memory.current.trail = next;
      }
    }

    // Kamera: póza ze stavu s míčkem, kde je nakreslený; přechody vede `minigolfCameraStep` (P71C T2).
    if (camera.view !== null) camera.clearViewOffset();
    if (drawn.current.length !== state.length) drawn.current = new Int32Array(state.length);
    const view = drawn.current;
    view.set(state);
    view[p + BODY.x] = Math.round(-at.x * UNIT);
    view[p + BODY.z] = Math.round(at.z * UNIT);
    const tick = state[HEADER.tick] as number;
    const card = tick === 0 ? startArea(surface.current, playRect.current) : null;
    // Plocha pod kartou drží až do první rány: karta zmizí s prvním tikem, tedy uprostřed prvního míření.
    if (strokesOf(state) > 0) startFrame.current = null;
    else if (card !== null) startFrame.current = card;
    const pose = minigolfCameraPose(view, camera.aspect, playRect.current, course.view, camera.fov, startFrame.current);
    minigolfCameraStep(rig, pose, tick, delta, card !== null);
    camera.position.copy(rig.eye);
    camera.lookAt(rig.look);
    camera.updateMatrixWorld();
  });

  const { bounds } = course;
  const middle = (bounds.x0 + bounds.x1) / 2;
  const reach = Math.max(Math.abs(bounds.x0), Math.abs(bounds.x1), Math.abs(bounds.z0), Math.abs(bounds.z1));
  return (
    <>
      {/* Ostrůvek diorama (P73D): podstavec, na něm vegetace sady mimo dráhu a čáru kamery, mezi ní stavby sady. */}
      <FieldGround look={look} area={dressing.land} y={-0.03} />
      {dressing.flora !== undefined && <VegetationAround flora={dressing.flora} seed={world.seed} box={dressing.box} clear={dressing.clear} layers={dressing.layers} land={dressing.land} />}
      <group position={[middle, 0, 0]}>
        <Scenery look={look} layout="sides" inner={(bounds.x1 - bounds.x0) / 2 + 3} from={bounds.z0 - 6} to={bounds.z1 + 6} vegetation={look.flora !== undefined} />
      </group>
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={reach + 8} />

      {/* Trávník dráhy (rovný: stín jen přijímá) a mantinely – každé jedna síť. */}
      {boxes.green !== null && (
        <mesh geometry={boxes.green} receiveShadow userData={{ rigShadow: 'receive' }}>
          <meshStandardMaterial color={colorHex.grass} roughness={0.95} />
        </mesh>
      )}
      {boxes.rails !== null && (
        <mesh geometry={boxes.rails} castShadow receiveShadow>
          <meshStandardMaterial color={colorHex['cream-deep']} roughness={0.7} />
        </mesh>
      )}

      {/* Jamka: kalíšek s okrajem (rovné, stín jen přijímají) a vlajka (`frame: 'target'` pro sondu čitelnosti). */}
      <group position={[course.hole.x, 0, course.hole.z]} userData={{ frame: 'target', item: 'goal' }}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]} receiveShadow userData={{ rigShadow: 'receive' }}>
          <circleGeometry args={[CUP_M, 32]} />
          <meshBasicMaterial color={colorHex.ink} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]} receiveShadow userData={{ rigShadow: 'receive' }}>
          <ringGeometry args={[CUP_M, CUP_M + 0.06, 32]} />
          <meshStandardMaterial color={colorHex.paper} roughness={0.6} />
        </mesh>
        <FittedModel id="finish-flag" w={FLAG.w} h={FLAG.h} d={FLAG.d} fallback={color.tomato} />
      </group>

      {/* Odrazníky a pohyblivá překážka: věci z věty; sokly odrazníků jedna síť, pohyblivá překážka si nese svůj. */}
      {boxes.plinths !== null && (
        <mesh geometry={boxes.plinths} receiveShadow>
          <meshStandardMaterial color={colorHex.ink} roughness={0.8} />
        </mesh>
      )}
      {course.bumpers.map((bumper) => (
        <group key={`bumper-${String(bumper.index)}`} position={[bumper.x, 0, bumper.z]} userData={{ item: 'obstacle' }}>
          <Obstacle piece={bumper} />
        </group>
      ))}
      {course.mover !== null && (
        <group ref={mover} position={[course.mover.x, 0, course.mover.z]} userData={{ item: 'obstacle' }}>
          <mesh position={[0, PLINTH_H / 2, 0]} receiveShadow>
            <boxGeometry args={[course.mover.w, PLINTH_H, course.mover.d]} />
            <meshStandardMaterial color={colorHex.ink} roughness={0.8} />
          </mesh>
          <Obstacle piece={course.mover} />
        </group>
      )}

      {/* Míček (hráč). */}
      {/* Koule s plochými stěnami, ať je valení vidět; točí se kolem středu (`spin` ve výšce poloměru). */}
      <group ref={ball} userData={{ frame: 'hero' }}>
        <group ref={spin} position={[0, BALL_M / 2, 0]}>
          <mesh castShadow>
            <icosahedronGeometry args={[BALL_M / 2, 1]} />
            <meshStandardMaterial color={colorHex.paper} roughness={0.5} flatShading />
          </mesh>
        </group>
      </group>

      {/* Stopa míření: pomůcka, mlha rigu ji nezakryje a stín nevrhá; vrcholy píše scéna, obal se nepočítá. */}
      <mesh ref={trailMesh} geometry={trail.geometry} visible={false} frustumCulled={false} userData={{ rigShadow: 'none' }}>
        <meshBasicMaterial color={colorHex.paper} vertexColors transparent fog={false} />
      </mesh>
      <GhostSlot ghost={ghost} session={session} place={worldPlacement} />
    </>
  );
}
