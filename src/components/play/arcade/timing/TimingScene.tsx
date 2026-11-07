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
import { Box3, MathUtils, Vector3 } from 'three';

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
import { DIORAMA_FRAMING } from '../look/framing';
import type { Box } from '../look/ground';
import type { Volume } from '../look/landmark-places';
import { Landmark } from '../look/Landmark';
import { Scenery } from '../look/Scenery';
import { fitTall, usePlayRectRef } from '../portrait-frame';
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
const SCENERY_BEHIND = 10;
/**
 * Řada kulis za věží (P73D, s4): kusy po ose x od −26 do 26 m, ale ne blíž než `SCENERY_CLEAR` od osy pohledu.
 * Dřív stála řada 7 m za věží od −14 do 14 m a černá vrátnice a věž hradu trčely těsně za kyvem jako skvrny;
 * teď prostředek obrazu za věží (v hloubce řady ±0,4 šířky) zůstane volný a kusy stojí po stranách jako místo.
 */
const SCENERY_SPAN = 26;
const SCENERY_CLEAR = 9;
/** Zem načasování (m): do stran za kyv jezdce, dozadu pod kulisy a do mlhy. */
const TIMING_LAND = { x0: -40, x1: 40, z0: -20, z1: 60 } as const;
/** Nejbližší vrstva kulisy (m od kamery 11,7+ m před věží): za řadou kulis (10–15 m za věží, v obraze nejdál ~31 m od kamery). */
const BACKDROP_BEYOND = 32;
/** Věž a kyv jezdce (±3 m a díl): orientační bod a rámující kusy stojí mimo (P54B T8). */
const TIMING_AREA: readonly Box[] = [{ x0: -(TIMING.amplitude / UNIT + 2), x1: TIMING.amplitude / UNIT + 2, z0: -2, z1: 2 }];

/** Model z popisku role vepsaný do kvádru těla (w × h × d, metry), postavený na zem. */
export type BodyModel = (w: number, h: number, d: number) => React.ReactNode;

/**
 * Hrdina věty (P58A T8) stojí před věží za krajem kyvu, natočený napůl ke kameře a napůl k věži – z profilu
 * se zvíře pozná líp než zepředu. Na šířku (kamera 12,8 m, `TIMING_BACK`) má kolem 14 % výšky snímku; hloubka kvádru nechá
 * dlouhé zvíře (ještěrka, tuleň) vyrůst do výšky. Kyv jezdce (±3 m, blok věže ±4,2 m) ho míjí za zády.
 */
const HERO_M = { w: 1.2, h: 1.8, d: 1.6 };
/** Lano nad visící věcí a ten, kdo ji za cílem čeká (P71C T3): hlava nad lištou, věc o kus výš. */
const ROPE_LENGTH = 3;
const ROPE_COLOR = '#a16207';
const GOAL_M = { w: 1.4, h: 1.5, d: 1.2 };
const HERO_AT: readonly [number, number, number] = [-(TIMING.amplitude / UNIT + 1), 0, -2.2];
const HERO_TURN = (3 * Math.PI) / 4;
/**
 * Na výšku (P61 T6) stojí hrdina v popředí pod věží: `front` = podíl vzdálenosti kamery od věže, `x` = kousek
 * stranou (m). Za krajem kyvu by ho těsná kamera na výšku uřízla celého – dřív z něj byla vidět půlka.
 */
const HERO_TALL = { front: 0.55, x: -0.5 } as const;
/** Místo hrdiny (půdorys natočeného kvádru): rámující kus kulis ho v obraze nezakryje – ledový oblouk schoval tučňáka (s47). */
const heroPlayOf = ([x, , z]: readonly [number, number, number]): readonly Volume[] => [{ x0: x - 1, y0: 0, z0: z - 1, x1: x + 1, y1: HERO_M.h, z1: z + 1 }];

/** Rezerva kyvu do stran (m) – i nad zaokrouhlení amplitudy sudou periodou (nejvýš polovina dráhy za tik). */
const SWING_PAD = 0.4;

/**
 * Jak daleko před věží kamera stojí (m): vidět celý kyv jezdce (amplituda, půl jezdce, rezerva) k přední stěně
 * jezdce, ať jeho roh na kraji kyvu nevyjede ze záběru. P61 T6: šířka z kyvu, jaký jezdec opravdu má, místo
 * pevných 10 m – na výšku rozhoduje šířka, jehla (0,2 m) tak stála na Pixelu 7 17,7 m daleko a měla 0,8 % plochy
 * obrazu proti 1,3 % na šířku. Blok věže (2,4 m) zůstal skoro, kde byl (17,4 m); na šířku rozhoduje výška (7 m)
 * a spodní mez 8 m, tam se nic nemění. simplified: jezdce zvětšeného čitelností (až `LEGIBLE_CAP`×) kamera
 * nepočítá – jeho přední roh na kraji kyvu se na výšku dotkne kraje obrazu; se stropem v šířce by blok věže
 * odjel o 30 % dál než dřív. Až bude vadit, rámovat kyv podle měřítka, které jezdec opravdu má.
 */
export function timingDistance(fov: number, aspect: number, sliderW: number): number {
  const tan = Math.tan((fov * Math.PI) / 360);
  const swing = 2 * (TIMING.amplitude / UNIT + sliderW / 2 + SWING_PAD);
  return Math.max(swing / (2 * tan * aspect) + TIMING.depth / UNIT / 2, 7 / (2 * tan), 8);
}

/**
 * O kolik dál než `timingDistance` stojí kamera (P73D T2: výš a dál, ať je za věží vidět svět a obzor). Na šířku je
 * to 8 m × 1,6 = 12,8 m: jezdec zvětšený čitelností na strop (`LEGIBLE_CAP` 2×, 4,8 m) má ~22–25 % šířky obrazu
 * místo ~30–33 % při 1,25 (s4: kvádr skoro přes půl obrazu), hrdina věty stojí kolem NDC x 0,45 místo 0,55.
 * Na výšku polohu určí `fitTall` (posune kameru po ose pohledu), tam se nic nemění.
 */
export const TIMING_BACK = 1.6;

/**
 * Kamera stohování (P73D T2): jezdec nad věží uprostřed záběru, sklon `DIORAMA_FRAMING.timing` – dřív 10° od země,
 * kvádr přes půl obrazu a za ním dlažba. Na výšku pak `fitTall` do hracího obdélníku (orientace i obzor drží).
 */
export function placeTiming(camera: PerspectiveCamera, look: Vector3, followY: number, distance: number): void {
  const pitch = MathUtils.degToRad(DIORAMA_FRAMING.timing.pitch);
  const reach = distance * TIMING_BACK;
  look.set(0, followY, 0);
  camera.position.set(0, followY + reach * Math.sin(pitch), -reach * Math.cos(pitch));
  camera.lookAt(look);
}

/** Kolik stohu pod jezdcem drží kvádr na výšku (m) a jak vysoký kvádr nanejvýš je – na Pixelu 7 se vejde na `timingDistance`. */
const TALL_BELOW = 2;
const TALL_SPAN = 6;

/**
 * Kvádr hry pro `fitTall` na výšku (P64 T8-R3): kyv jezdce do stran a okno věže kolem jezdce (`followY`) – pod ním
 * `TALL_BELOW` stohu, nad ním dva díly a cíl (`goalTop`), dokud se okno vejde do `TALL_SPAN`. Celá cílová věž
 * (36 palačinek = 22 m) kameru odvezla do mlhy (b64-01, p64-08); s oknem drží šířku `timingDistance` a fit jen posune.
 */
export function timingTallBox(out: Box3, followY: number, goalTop: number, sliderW: number): Box3 {
  const swing = TIMING.amplitude / UNIT + sliderW / 2 + SWING_PAD;
  const bottom = Math.max(0, followY - TALL_BELOW);
  const next = followY + (2 * TIMING.blockH) / UNIT;
  out.min.set(-swing, bottom, -TIMING.depth / UNIT / 2);
  out.max.set(swing, Math.max(next, Math.min(goalTop + 1, bottom + TALL_SPAN)), TIMING.depth / UNIT / 2);
  return out;
}

/** Kde stojí hrdina věty: na šířku za krajem kyvu, na výšku v popředí pod věží (`HERO_TALL`). */
function timingHeroAt(aspect: number, distance: number): readonly [number, number, number] {
  return aspect < 1 ? [HERO_TALL.x, 0, -HERO_TALL.front * distance] : HERO_AT;
}

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

/**
 * `blockModel` (P30B T4): díl věže z popisku role `block` („pancakes“), vyplní kvádr dílu; jen u stavění věže.
 * `heroModel` (P58A T8): hrdina z věty („grandma“, „monkey“) vedle věže; výchozí průzkumník se nekreslí.
 */
export function TimingScene({
  session,
  look: scene,
  blockModel,
  goalModel,
  heroModel,
  ghost,
}: {
  readonly session: ArcadeSession;
  readonly look: Look;
  readonly blockModel?: BodyModel;
  /** Komu lišta věc dopraví (P71C T3, „feed the monster“): stojí za cílem a věc nad ním visí na laně. */
  readonly goalModel?: BodyModel;
  readonly heroModel?: BodyModel;
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
  const riderScale = useRef<Group | null>(null);
  const placedPoses = useRef<(Group | null)[]>([]);
  const heroPose = useRef<Group | null>(null);
  const toyPose = useRef<ToyPose | null>(null);
  const posedRound = useRef(-1);
  // Jehla a prkno můstku nejsou díly věže – model z popisku nese jen `block`.
  const blocks = sliderKind === 'block' ? blockModel : undefined;
  // P58A T6: věc z věty na liště („pancakes“) jede na ručičce jako čtverec o výšce dílu; ručička zůstává.
  const rider = sliderKind === 'needle' ? blockModel : undefined;
  // „cut the rope“ (P71C T3): věc z věty visí na laně místo ručičky a pod cílem čeká, kdo ji sní.
  const hang = rider !== undefined && goalModel !== undefined;
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  // Poměr stran kamery: R3F ho po změně velikosti plátna přepíše dřív, než se ptá selektorů scén.
  const aspect = useThree((three) => (three.camera as PerspectiveCamera).aspect);
  const look = useMemo(() => new Vector3(), []);
  const play = useMemo(() => new Box3(), []);
  const playArea = usePlayRectRef();
  const followY = useRef<number | null>(null);
  // Hrdina a jeho místo pro kulisy podle poměru stran: na výšku ho kamera má v popředí (P61 T6).
  const heroAt = useMemo(() => timingHeroAt(aspect, timingDistance(camera.fov, aspect, sliderInit.w)), [aspect, camera.fov, sliderInit.w]);
  const heroPlay = useMemo(() => heroPlayOf(heroAt), [heroAt]);
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
      // Věc na ručičce vrací jen změnu šířky z jádra (P71C T3) – `1 / sliderInit.w` ji roztáhl pětkrát do pruhu.
      if (riderScale.current !== null) riderScale.current.scale.x = 1 / Math.max(0.001, group.scale.x);
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
    if (heroPose.current !== null) applyToy({ group: heroPose.current }, pose, HERO_M.h);
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
    // Vidět celý kyv i na výšku: vzdálenost z poměru stran (`timingDistance`).
    const dist = timingDistance(camera.fov, camera.aspect, sliderInit.w);
    placeTiming(camera, look, followY.current, dist);
    const rect = playArea.current;
    if (camera.aspect < 1 && rect !== null) {
      // Na výšku (P64 T4, T8-R3): kyv jezdce a okno věže kolem něj v `playRect` pod HUD – šířku dál drží `timingDistance`.
      camera.position.copy(fitTall(camera, timingTallBox(play, followY.current, top, sliderInit.w), rect, { margin: 0 }).position);
    }
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
        <Scenery look={scene} layout="behind" inner={SCENERY_BEHIND} from={-SCENERY_SPAN} to={SCENERY_SPAN} clear={SCENERY_CLEAR} />
      </group>
      {/* Kulisa za mlhou (P46G T7) za řadou kulis; vegetace ne – plocha je jen věž a kyv jezdce. */}
      <HorizonBackdrop look={scene} seed={world.seed} clear={0} beyond={BACKDROP_BEYOND} />
      <Landmark look={scene} seed={world.seed} area={TIMING_AREA} play={heroModel === undefined ? undefined : heroPlay} />
      <mesh position={[0, base.h / 2, 0]}>
        <boxGeometry args={[base.w, base.h, depth]} />
        <meshStandardMaterial color={BASE_COLOR[baseKind] ?? '#475569'} roughness={0.8} />
      </mesh>
      {/* Tolerance: průsvitný sloupec nad středem – kam jezdce zastavit. */}
      {/* Pro sondu záběru (P27A T6) je tolerance cíl a jezdec hrdina. */}
      <mesh position={[-target.x, top / 2 + 0.5, -depth / 2 - 0.02]} userData={{ frame: 'target' }}>
        <boxGeometry args={[target.w, top + 1, 0.02]} />
        {/* P75 T6: slabší – soudce četl plný sloupec jako zelený pruh přes palačinky. */}
        <meshBasicMaterial color="#16a34a" transparent opacity={0.14} />
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
          {hang ? (
            <mesh position={[0, 2 * blockH + ROPE_LENGTH / 2, 0]} userData={{ rope: true }}>
              <cylinderGeometry args={[0.035, 0.035, ROPE_LENGTH, 6]} />
              <meshStandardMaterial color={ROPE_COLOR} roughness={0.9} />
            </mesh>
          ) : blocks !== undefined ? (
            blocks(sliderInit.w, blockH, depth)
          ) : (
            <mesh position={[0, blockH / 2, 0]}>
              <boxGeometry args={[sliderInit.w, blockH, depth]} />
              <meshStandardMaterial color={SLIDER_COLOR[sliderKind] ?? '#f59e0b'} roughness={0.5} />
            </mesh>
          )}
          {rider === undefined ? null : (
            // Ručičku mění jádro v šířce (`scale.x`); věc nad ní tu změnu vrací, ať se nezplacatí.
            <group ref={riderScale} position={[0, blockH, 0]} userData={{ item: 'block' }}>
              {rider(blockH, blockH, depth)}
            </group>
          )}
        </group>
      </group>
      {hang && (
        // Za cílem, čelem ke kameře: nad lištou vykukuje hlava, nad ní jede věc na laně.
        <group position={[-target.x, 0, depth / 2 + GOAL_M.d / 2 + 0.2]} rotation={[0, Math.PI, 0]} userData={{ goal: true }}>
          {goalModel(GOAL_M.w, GOAL_M.h, GOAL_M.d)}
        </group>
      )}
      {heroModel !== undefined && (
        <group position={heroAt} rotation={[0, HERO_TURN, 0]}>
          {/* Hrdinou sondy zůstává jezdec; hračkovou pózu postavy čte `heroToy` sondy (P45D T14), popisek jména jde nad ni. */}
          <group ref={heroPose} userData={{ toyHero: true }}>{heroModel(HERO_M.w, HERO_M.h, HERO_M.d)}</group>
        </group>
      )}
      {/* Slot ducha (P37-0 T3) vedle jezdce, ne v jeho skupině. */}
      <GhostSlot ghost={ghost} session={session} place={ghostSpot} />
    </>
  );
}
