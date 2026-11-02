'use client';

/**
 * Scéna směny se stavbou obchodu (P68-S T5): pevná deska obchodu 3/4 shora, pod ní řada palety. Kamera, buňky pro
 * prst (`data-lane-cells`) a souřadnice jsou v `buildshift-camera.ts`; deska se kreslí ve skupině otočené o π, uvnitř
 * jsou souřadnice jádra v metrech (dveře, řada 5, jsou dole u kamery).
 *
 * - **Deska:** dlaždice 5 × 6 s mezerami (hranice buněk), nízké stěny, dveře (mátová rohožka), přední zeď 25 a 29.
 *   Na zdi 25 cedule **Served** s počtem a cílem, na zdi 29 květináč.
 * - **Stanoviště** z dnešního katalogu (pec `cc0-oven`, pult `gen3d-checkout-counter`, police `gen3d-bread-rack`;
 *   bez modelu zaoblený kvádr v barvě kitu). Na peci a polici leží hotové zboží podle zásoby, nad pecí pruh pečení.
 * - **Zboží** z obsazení věty (`cast.things.goods`, jinak pizza), **zákazníci** taky (`cast.things.customer`, jinak
 *   nepřítel věty), každý s ukazatelem trpělivosti nad hlavou; fronta je poloha z jádra. **Prodavač** = hrdina věty,
 *   nese zboží v rukou; u stanoviště stojí za ním.
 * - **Paleta:** Oven, Counter, Shelf s cenou (vybraný druh vyjede a je slunečný, na co mince nestačí, je tlumený),
 *   **Coins** s počtem mincí a **Open** – jediná rajčatová akce, ve fázi stavby s ubývajícím pruhem okna stavby.
 * - Volná stavební buňka svítí, je-li vybraný druh a mince na něj; odmítnutý ťuk buňka krátce problikne poplachem
 *   a zatřese se, a chyběly-li mince, nad ní vyskočí cenovka s cenou. Cíl prodavače má slunečný kroužek.
 * - **Odezva směny (T10):** obsloužený zákazník = nad pultem vyskočí „+1“ s mincí; na pultu leží počet čekajících
 *   („3 in line“); v posledních 15 s hodin (rush jádra) visí na pravé zdi slunečná cedule **Rush!** místo květináče.
 *
 * Text (cedule, paleta) je kreslený do textur ve 3D, ne do DOM HUD – popisky „Served“ a „Coins“ zatím nejsou
 * v `HUD_COUNTER_LABELS` (požadavek v `integration.md`).
 *
 * Čte jen stav jádra (`buildshift-world.ts`) a tik kresby, do relace nic nepíše. Pohyb mimo hash: dech a rozhlížení
 * stojících zákazníků a tep cedule Rush! (sám od sebe – vypne je `prefers-reduced-motion` i `?toy=off`), naskočení
 * nového stanoviště, otřes odmítnuté buňky a výskok „+1“ (odpověď na akci – `prefers-reduced-motion` vypne otřes
 * a výskok, cenovka a „+1“ jen stojí), prolínání poloh mezi tiky. Kamera stojí daleko s úzkým úhlem, proto scéna posune mlhu (a vzdálenou rovinu kamery) za desku
 * a při odchodu je vrátí. Plocha dostane `data-lane-cells` (buňky pro `lanes-input.ts`) a `data-player-x`.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Color, Fog, type Group, InstancedMesh, type Material, Matrix4, type Mesh, MeshBasicMaterial, MeshStandardMaterial, type PerspectiveCamera, PlaneGeometry, type Quaternion, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { BODY, HEADER, RUN_STATE, UNIT, bodyBase, nativeRule } from '@/play/arcade/contract';
import { riggedCharacter } from '@/play/arcade/models';
import {
  BOARD_CELLS,
  BUILDSHIFT,
  CUSTOMER_SLOTS,
  PALETTE,
  PHASE,
  SHIFT_SLOTS,
  STATION_COST,
  STATION_KINDS,
  STATION_SLOTS,
  type StationKind,
  cellAtWorld,
  cellX,
  cellZ,
  colOf,
  counterOfCustomer,
  customersOf,
  isBuildCell,
  queueAt,
  rejectedCellOf,
  rowOf,
  shiftSlot,
  shiftView,
  stationCode,
} from '@/play/arcade/pieces/buildshift-world';

import { reducedMotion } from '../../effects/feel';
import { compileForComposer } from '../../../feed/StageHost';
import { renderHeld } from '../../effects/render-feel';
import { FieldGround } from '../../look/FieldGround';
import { loadsPending, loadsSettled } from '../../look/pending-loads';
import { type PlayRect, usePlayRectRef } from '../../portrait-frame';
import { RiggedModel } from '../../RiggedModel';
import { toyMotionOn } from '../../toy/applyToy';
import { FittedModel, type WorldProps } from '../../World';
import { GRID_BOX, VIEW, cellsAttr, placeCamera, tallFallback } from './buildshift-camera';
import { type Label, card, coin, createLabel, disposeLabel, paint, words } from './buildshift-labels';

type BuildshiftSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

const m = (units: number): number => units / UNIT;
const CELL = m(BUILDSHIFT.cell);
const HALF = (BUILDSHIFT.cols * CELL) / 2;
/** Zadní hrana desky a přední hrana palety (z jádra v m). */
const BACK_Z = m(cellZ(0)) - CELL / 2;
const FRONT_Z = m(cellZ(PALETTE.oven)) + CELL / 2;
const TILE = CELL - 0.1;
/** Barvy dlaždic podle kódu: 0 a 1 šachovnice, 2 dveře, 3 volná buňka, na kterou jde stavět. */
const TILE_COLORS = [color.cream, color['cream-deep'], color.mint, color['sun-soft']].map((hex) => new Color(hex));
const tileMatrix = new Matrix4();
const STATION_SIZE = { w: m(BUILDSHIFT.station.w), h: m(BUILDSHIFT.station.h), d: m(BUILDSHIFT.station.d) };
const SELLER = { w: m(BUILDSHIFT.seller.w), h: m(BUILDSHIFT.seller.h), d: m(BUILDSHIFT.seller.d) };
/** Zákazník se kreslí o kus větší než jeho tělo, ať je z výšky poznat, kdo to je. */
const CUSTOMER = { w: 0.95, h: 1.6, d: 0.95 };
const GOODS = { w: 0.5, h: 0.35, d: 0.5 };
const WALL = { h: 0.6, t: 0.3, block: 0.5 };

const STATION_MODEL: Readonly<Record<StationKind, string>> = { oven: 'cc0-oven', counter: 'gen3d-checkout-counter', shelf: 'gen3d-bread-rack' };
const STATION_TINT: Readonly<Record<StationKind, string>> = { oven: color['tomato-deep'], counter: color['sky-deep'], shelf: color['sun-deep'] };
const STATION_NAME: Readonly<Record<StationKind, string>> = { oven: 'Oven', counter: 'Counter', shelf: 'Shelf' };
/** Hotové zboží na stanovišti: místa nahoře (x v m), kolik jich je, tolik nejvýš zásoby. */
const GOODS_SPOTS: Readonly<Record<StationKind, readonly number[]>> = { oven: [-0.3, 0.3], counter: [], shelf: [-0.5, 0, 0.5] };
const DEFAULT_GOODS = 'pizza';
const DEFAULT_CUSTOMER = 'robot';

/** Zákazníků se kreslí naráz nejvýš tolik. simplified: přes strop se další nekreslí; zvednout, kdyby věta chtěla dav. */
const POOL = 12;
/**
 * Prodavač je hrdina (`frame: 'hero'` – stín, sondy), čitelnost (`LegibleBodies`, P58A) by ho ale zvětšila až na dvojnásobek
 * a na desce by zakryl buňku a půl: vnitřní skupina drží kreslenou velikost nejvýš na tolikanásobku.
 */
const SELLER_CAP = 1.3;
/** U stanoviště stojí prodavač za ním (m směrem k zadní stěně), dojíždí tolik za sekundu. */
const BEHIND = { z: -0.75, ease: 12 } as const;
/** Ukazatel nad hlavou: šířka a výška (m). T10: větší, ať je trpělivost ve frontě čitelná i na telefonu. */
const BAR = { w: 1.3, h: 0.28, fill: 0.18 } as const;
/** Dech a rozhlížení stojícího zákazníka: perioda (s), výška dechu, úhel rozhlížení (rad). */
const BREATH = { period: 2.6, amount: 0.03, look: 0.35 } as const;
/** Naskočení nového stanoviště a probliknutí odmítnutého ťuku (s). */
const POP_S = 0.22;
const FLASH_S = 0.35;
/**
 * Otřes odmítnuté buňky: délka (s), výchylka (m, na telefonu ~5 px – strop otřesu HUD je 6 px, `08-game-hud.md`),
 * kmitů za sekundu. Cenovka nad buňkou visí `PRICE_S`.
 */
const SHAKE = { s: 0.2, amount: 0.12, hz: 30 } as const;
const PRICE_S = 0.9;
/**
 * Nápověda „vyber stanici“ (P68-L T1) po ťuku na desku bez výběru: karty druhů v paletě svítí slunečně `s` sekund,
 * posledních `fade` vyhasínají, a každá poskočí o `hop` m (po `stagger` s za sebou, skok trvá `hopS`). Dohasne dřív,
 * než přijde další ťuk sondy (~0,75 s na desktopu), takže i opakovaný ťuk na tutéž buňku je vidět jako změna.
 */
const HINT = { s: 0.7, fade: 0.35, hop: 0.3, stagger: 0.06, hopS: 0.4 } as const;
const HINT_TINT = new Color(color.sun);
const WHITE = new Color(1, 1, 1);
/** Výskok „+1“ s mincí nad obslouženým: délka (s), výstup (m), naskočení (s, `duration-quick`), výška startu (m), kolik naráz. */
const PLUS = { s: 0.9, rise: 0.8, pop: 0.16, y: 2.1, pool: 3 } as const;
/** Tep cedule Rush!: perioda (s) a výchylka měřítka. */
const RUSH_PULSE = { period: 0.8, amount: 0.06 } as const;
/** Kartičky nad hlavou a na pultu (m). */
const SIGN = { price: 0.9, plus: 0.9, queue: 0.95 } as const;
/** Mlha začne tolik metrů za nejvzdálenějším rohem desky (s kulisou za zadní stěnou). */
const FOG_CLEAR = 6;
const LAND = { x0: -30, x1: 30, z0: -30, z1: 40 } as const;

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const kindOfCode = (code: number): StationKind | null => STATION_KINDS[code - 1] ?? null;

// ---------------------------------------------------------------------------
// Díly

/** Postava z popisku: riggovaná, nebo model vepsaný do kvádru. */
function Figure({ model, size, tint, moving }: { readonly model: string; readonly size: { readonly w: number; readonly h: number; readonly d: number }; readonly tint: string; readonly moving: () => boolean }) {
  const rig = riggedCharacter(model);
  return rig !== undefined ? (
    <RiggedModel character={rig} h={size.h} clip={() => (moving() ? 'walk' : 'idle')} fallback={tint} />
  ) : (
    <FittedModel id={model} w={size.w} h={size.h} d={size.d} fallback={tint} character />
  );
}

/** Pruh nad tělem čelem ke kameře: inkoustový podklad, výplň se zkracuje zprava. */
function Bar({ y, fill, material }: { readonly y: number; readonly fill: (mesh: Mesh | null) => void; readonly material: Material }) {
  return (
    <group position={[0, y, 0]} rotation={[-VIEW.pitch, 0, 0]}>
      <mesh>
        <planeGeometry args={[BAR.w, BAR.h]} />
        <meshBasicMaterial color={color.ink} toneMapped={false} />
      </mesh>
      <mesh ref={fill} position={[0, 0, 0.01]} material={material}>
        <planeGeometry args={[BAR.w - 0.08, BAR.fill]} />
      </mesh>
    </group>
  );
}

/** Odkazy na kus stanoviště, které scéna každý snímek přepisuje. */
interface StationRefs {
  group: Group | null;
  readonly goods: (Group | null)[];
  bake: Mesh | null;
  /** Pult: kartička s počtem čekajících a její popisek (jen pult ho má). */
  queue: Mesh | null;
  readonly line: Label | null;
  readonly born: number;
}

/** Výskok „+1“: skupina, kdy začal (s kresby, −1 = volný). */
interface Plus {
  group: Group | null;
  start: number;
}

interface StationView {
  readonly cell: number;
  readonly kind: StationKind;
}

/** Slot zásoby zákazníků: tělo, které kreslí (−1 = volný), a zda se v tomto snímku hýbe. */
interface Slot {
  body: number;
  moving: boolean;
}

interface Pose {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly fov: number;
  readonly attr: string;
  /** Hloubka nejvzdálenějšího rohu desky (m) – odtud se posouvá mlha. */
  readonly reach: number;
}

/** Hloubka nejvzdálenějšího rohu krabice desky před kamerou. */
function reachOf(camera: PerspectiveCamera): number {
  const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const corner = new Vector3();
  let reach = 0;
  for (let i = 0; i < 8; i += 1) {
    corner.set(i & 1 ? GRID_BOX.max.x : GRID_BOX.min.x, i & 2 ? GRID_BOX.max.y : GRID_BOX.min.y, i & 4 ? GRID_BOX.max.z : GRID_BOX.min.z);
    reach = Math.max(reach, corner.sub(camera.position).dot(forward));
  }
  return reach;
}

// ---------------------------------------------------------------------------

export function BuildshiftScene({ session, cast, surface, scene: look }: BuildshiftSceneProps) {
  const world = session.world;
  const goal = useMemo(() => Number(nativeRule(world.rules, 'buildshift_goal')?.params.goal ?? BUILDSHIFT.goal.default), [world]);
  /** První tik rushe (svět uložený před T10 rush nemá – cedule pak nevisí). */
  const rushFrom = useMemo(() => {
    const rush = (nativeRule(world.rules, 'buildshift_shift')?.params as { readonly rush?: readonly number[] } | undefined)?.rush ?? [];
    return rush.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...rush);
  }, [world]);
  const goodsModel = cast.things?.goods ?? DEFAULT_GOODS;
  const customerModel = cast.things?.customer ?? (cast.enemy === '' ? DEFAULT_CUSTOMER : cast.enemy);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const playRect = usePlayRectRef();
  const [stations, setStations] = useState<readonly StationView[]>([]);

  const clock = useRef(0);
  const stationKey = useRef('');
  const stationRefs = useRef(new Map<number, StationRefs>());
  const paletteTiles = useRef<(Group | null)[]>([]);
  const openBar = useRef<Mesh | null>(null);
  const flash = useRef<Mesh | null>(null);
  /** Odmítnutý ťuk: buňka, do kdy bliká, začátek otřesu, poslední viděná hodnota slotu a cena, která chyběla (0 = žádná). */
  const flashState = useRef({ cell: -1, until: 0, start: 0, last: 0, price: 0, hint: -Infinity });
  const price = useRef<Group | null>(null);
  /** Druh, který byl naposledy vybraný (ve fázi provozu ťuk na desku výběr smaže dřív, než ho scéna uvidí). */
  const lastSelected = useRef(0);
  /** Co otřes posunul: buňka (dlaždice a stanoviště se po otřesu vrátí). */
  const shaken = useRef(-1);
  const pluses = useRef<Plus[]>(Array.from({ length: PLUS.pool }, () => ({ group: null, start: -1 })));
  const servedSeen = useRef(0);
  const rushSign = useRef<Group | null>(null);
  const pot = useRef<Group | null>(null);
  const ring = useRef<Group | null>(null);
  const hero = useRef<Group | null>(null);
  const heroInner = useRef<Group | null>(null);
  const heroYaw = useRef<Group | null>(null);
  const carried = useRef<Group | null>(null);
  const sellerMemory = useRef({ moving: false, behind: 0 });
  const slots = useRef<Slot[]>(Array.from({ length: POOL }, () => ({ body: -1, moving: false })));
  const customerGroups = useRef<(Group | null)[]>([]);
  const customerInner = useRef<(Group | null)[]>([]);
  const patience = useRef<(Mesh | null)[]>([]);
  const poseKey = useRef<{ readonly rect: PlayRect | null; readonly width: number; readonly height: number; readonly tall: boolean } | null>(null);
  const pose = useRef<Pose | null>(null);
  /** Mlha rigu, jak ji sada nastavila (vrací se při odchodu), a pro jakou hloubku desky je posunutá. */
  const fogOrigin = useRef<{ readonly fog: Fog; readonly near: number; readonly far: number } | null>(null);
  const fogPushed = useRef<{ readonly fog: Fog; readonly reach: number } | null>(null);
  const cameraFar = useRef(camera.far);
  const probe = useMemo(() => new Vector3(), []);

  const materials = useMemo(
    () => ({
      floor: new MeshStandardMaterial({ roughness: 0.9 }),
      calm: new MeshBasicMaterial({ color: color['mint-deep'], toneMapped: false }),
      warn: new MeshBasicMaterial({ color: color.sun, toneMapped: false }),
      urgent: new MeshBasicMaterial({ color: color.alarm, toneMapped: false }),
      bake: new MeshBasicMaterial({ color: color.sun, toneMapped: false }),
    }),
    [],
  );
  const labels = useMemo(() => {
    const made = { palette: STATION_KINDS.map(() => createLabel()), coins: createLabel(), open: createLabel(), served: createLabel(), price: createLabel(), plus: createLabel(), rush: createLabel() };
    // Neměnné kartičky se nakreslí hned: „+1“ s mincí a Rush!.
    paint(made.plus, 'plus', (context) => {
      card(context, color.paper, 12);
      words(context, '+1', 100, 132, 112, 900, color.ink);
      coin(context, 192, 128, 44, '');
    });
    paint(made.rush, 'rush', (context) => {
      card(context, color.sun, 14);
      words(context, 'Rush!', 128, 132, 78, 900, color.ink);
    });
    return made;
  }, []);
  /** Kartičky front u pultů (podle buňky); vznikají s pultem, uvolní je odchod scény. */
  const lines = useRef(new Map<number, Label>());
  /**
   * Podlaha desky jedním voláním kreslení (P68-K T2): 33 dlaždic po vlastní síti byla na Pixelu 7 (CPU ×4) skoro třetina
   * volání snímku. Barva dlaždice (šachovnice, dveře, volná buňka) je barva instance, otřes posune její matici.
   */
  const floor = useMemo(() => {
    const cells = Array.from({ length: BOARD_CELLS }, (_, cell) => cell).filter((cell) => !BUILDSHIFT.walls.includes(cell));
    const mesh = new InstancedMesh(new PlaneGeometry(TILE, TILE), materials.floor, cells.length);
    mesh.receiveShadow = true;
    const shown = new Int8Array(cells.length);
    cells.forEach((cell, i) => {
      mesh.setMatrixAt(i, tileMatrix.makeRotationX(-Math.PI / 2).setPosition(m(cellX(cell)), 0.01, m(cellZ(cell))));
      shown[i] = cell === BUILDSHIFT.door ? 2 : (colOf(cell) + rowOf(cell)) % 2;
      mesh.setColorAt(i, TILE_COLORS[shown[i] as number] as Color);
    });
    mesh.computeBoundingSphere();
    return { mesh, cells, index: new Map(cells.map((cell, i) => [cell, i])), shown };
  }, [materials]);
  const shiftTile = (cell: number, dx: number): void => {
    const i = floor.index.get(cell);
    if (i === undefined) return;
    floor.mesh.setMatrixAt(i, tileMatrix.makeRotationX(-Math.PI / 2).setPosition(m(cellX(cell)) + dx, 0.01, m(cellZ(cell))));
    floor.mesh.instanceMatrix.needsUpdate = true;
  };

  useEffect(
    () => () => {
      for (const material of [materials.floor, materials.calm, materials.warn, materials.urgent, materials.bake]) material.dispose();
      for (const label of [...labels.palette, labels.coins, labels.open, labels.served, labels.price, labels.plus, labels.rush, ...lines.current.values()]) disposeLabel(label);
      floor.mesh.geometry.dispose();
      floor.mesh.dispose();
    },
    [materials, labels, floor],
  );

  /**
   * Předehřátí (P68-K T2): programy shaderů všech materiálů scény, i skrytých (zboží, zákazníci z fondu, cenovka, +1,
   * kruh cíle), se přeloží mimo hlavní vlákno hned po načtení modelů. Bez něj je three překládal až při prvním
   * zobrazení: na Pixelu 7 (CPU ×4) stál start dema snímek s ~280 ms překladu a první zboží a zákazník 44–64 ms.
   * Postup je `readyToDraw` z `StageHost` (ten drží jen vyměněnou scénu, ne první): překládat, dokud další průchod po
   * doběhnutí načítání nepřidá program.
   */
  const get = useThree((three) => three.get);
  useEffect(() => {
    let live = true;
    void (async () => {
      for (let pass = 0; live; pass += 1) {
        const before = get().gl.info.programs?.length ?? 0;
        await compileForComposer(get());
        if (pass > 0 && loadsPending() === 0 && (get().gl.info.programs?.length ?? 0) === before) return;
        await loadsSettled();
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    })();
    return () => {
      live = false;
    };
  }, [get]);

  // Zorný úhel, vzdálená rovina a mlha patří rigu: po odchodu scény se vrátí, stejně jako buňky na ploše.
  useEffect(() => {
    const fov = camera.fov;
    const far = camera.far;
    const host = surface.current;
    return () => {
      const origin = fogOrigin.current;
      if (origin !== null) {
        origin.fog.near = origin.near;
        origin.fog.far = origin.far;
      }
      camera.fov = fov;
      camera.far = far;
      camera.updateProjectionMatrix();
      if (host !== null) {
        delete host.dataset.laneCells;
        delete host.dataset.playerX;
      }
    };
  }, [camera, surface]);

  useFrame((three, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    clock.current += delta;
    const now = clock.current;
    const state = session.state();
    const prev = session.prev();
    const view = shiftView(state);
    const tick = state[HEADER.tick] as number;
    const motion = toyMotionOn();

    // Stanoviště: seznam pro React jen při změně (stavba je vzácná), vše ostatní přes odkazy.
    let key = '';
    for (let cell = 0; cell < BOARD_CELLS; cell += 1) {
      const body = view.stations[cell] as number;
      if (body >= 0) key += `${cell}:${stationCode(state, body)},`;
    }
    if (key !== stationKey.current) {
      stationKey.current = key;
      const next: StationView[] = [];
      for (const part of key.split(',')) {
        if (part === '') continue;
        const [cell, code] = part.split(':').map(Number) as [number, number];
        const kind = kindOfCode(code);
        if (kind !== null) next.push({ cell, kind });
      }
      for (const cell of [...stationRefs.current.keys()]) if (!next.some((station) => station.cell === cell)) stationRefs.current.delete(cell);
      for (const { cell, kind } of next) {
        if (stationRefs.current.has(cell)) continue;
        let line: Label | null = null;
        if (kind === 'counter') {
          line = lines.current.get(cell) ?? createLabel();
          lines.current.set(cell, line);
        }
        stationRefs.current.set(cell, { group: null, goods: [], bake: null, queue: null, line, born: now });
      }
      setStations(next);
    }

    // Kamera: póza jen při změně plátna, obdélníku nebo orientace; každý snímek se jen obnoví (otřes ji smí pohnout).
    // Hrací obdélník i na šířku: dolní řada HUD vede přes celou šířku a paleta musí ležet nad ní.
    const tall = camera.aspect < 1;
    const rect = playRect.current;
    const known = poseKey.current;
    if (known === null || known.rect !== rect || known.width !== three.size.width || known.height !== three.size.height || known.tall !== tall) {
      poseKey.current = { rect, width: three.size.width, height: three.size.height, tall };
      if (camera.view?.enabled === true) camera.clearViewOffset();
      placeCamera(camera, three.size, rect ?? tallFallback(three.size));
      pose.current = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), fov: camera.fov, attr: cellsAttr(camera, three.size), reach: reachOf(camera) };
    }
    const placed = pose.current as Pose;
    camera.position.copy(placed.position);
    camera.quaternion.copy(placed.quaternion);
    if (camera.fov !== placed.fov) {
      camera.fov = placed.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    // Mlha a vzdálená rovina za deskou (kamera stojí daleko kvůli rovnoměrným buňkám).
    const fog = three.scene.fog;
    if (fog instanceof Fog) {
      if (fogOrigin.current?.fog !== fog) fogOrigin.current = { fog, near: fog.near, far: fog.far };
      if (fogPushed.current?.fog !== fog || fogPushed.current.reach !== placed.reach) {
        const origin = fogOrigin.current;
        fog.near = Math.max(origin.near, placed.reach + FOG_CLEAR);
        fog.far = fog.near + Math.max(1, origin.far - origin.near);
        fogPushed.current = { fog, reach: placed.reach };
      }
    }
    const far = Math.max(cameraFar.current, fog instanceof Fog ? fog.far : placed.reach + FOG_CLEAR);
    if (camera.far !== far) {
      camera.far = far;
      camera.updateProjectionMatrix();
    }

    // Dlaždice: volná stavební buňka svítí, když je vybraný druh a mince na něj.
    const selectedKind = kindOfCode(view.selected);
    const canBuild = selectedKind !== null && view.coins >= STATION_COST[selectedKind];
    floor.cells.forEach((cell, i) => {
      if (cell === BUILDSHIFT.door) return;
      const code = canBuild && isBuildCell(cell) && view.stations[cell] === -1 ? 3 : (colOf(cell) + rowOf(cell)) % 2;
      if (floor.shown[i] === code) return;
      floor.shown[i] = code;
      floor.mesh.setColorAt(i, TILE_COLORS[code] as Color);
      floor.mesh.instanceColor!.needsUpdate = true;
    });

    // Odmítnutý ťuk (zabraná buňka, zeď, málo mincí): buňka krátce problikne poplachem a zatřese se; chyběly-li mince
    // na vybraný druh, nad buňkou vyskočí cenovka. Ve fázi provozu ťuk na desku výběr smaže – cenu dá poslední viděný.
    // Ťuk na desku bez vybraného druhu ve fázi stavby navíc rozsvítí a nadhodí paletu (P68-L T1): „vyber stanici“.
    if (view.selected > 0) lastSelected.current = view.selected;
    const rejected = shiftSlot(state, SHIFT_SLOTS.rejected);
    const blink = flashState.current;
    if (rejected !== blink.last) {
      blink.last = rejected;
      if (rejected > 0) {
        const tried = kindOfCode(view.phase === PHASE.build ? view.selected : lastSelected.current);
        blink.cell = rejectedCellOf(rejected);
        blink.start = now;
        blink.until = now + FLASH_S;
        blink.price = tried !== null && view.coins < STATION_COST[tried] ? STATION_COST[tried] : 0;
        if (view.phase === PHASE.build && view.selected === 0) blink.hint = now;
      }
    }
    const reduced = reducedMotion();
    const shakeLeft = 1 - (now - blink.start) / SHAKE.s;
    const shake = blink.cell >= 0 && shakeLeft > 0 && !reduced ? SHAKE.amount * shakeLeft * Math.sin((now - blink.start) * SHAKE.hz * Math.PI * 2) : 0;
    if (shaken.current >= 0 && (shake === 0 || shaken.current !== blink.cell)) {
      shiftTile(shaken.current, 0);
      stationRefs.current.get(shaken.current)?.group?.position.setX(m(cellX(shaken.current)));
      shaken.current = -1;
    }
    if (shake !== 0) {
      shaken.current = blink.cell;
      shiftTile(blink.cell, shake);
      stationRefs.current.get(blink.cell)?.group?.position.setX(m(cellX(blink.cell)) + shake);
    }
    if (flash.current !== null) {
      flash.current.visible = blink.cell >= 0 && now < blink.until;
      // Na zdi nahoře, jinak na podlaze – pod stanovištěm vykouknou okraje.
      if (flash.current.visible) flash.current.position.set(m(cellX(blink.cell)) + shake, (BUILDSHIFT.walls.includes(blink.cell) ? WALL.block : 0) + 0.03, m(cellZ(blink.cell)));
    }
    if (price.current !== null) {
      price.current.visible = blink.cell >= 0 && blink.price > 0 && now < blink.start + PRICE_S;
      if (price.current.visible) {
        paint(labels.price, String(blink.price), (context) => {
          card(context, color.paper, 12);
          coin(context, 128, 128, 84, String(blink.price));
        });
        const rise = reduced ? 1 : Math.min(1, (now - blink.start) / PLUS.pop);
        price.current.position.set(m(cellX(blink.cell)), STATION_SIZE.h + 0.5 + 0.3 * rise, m(cellZ(blink.cell)));
      }
    }

    // Obsloužený zákazník: nad prodavačem (stojí u pultu) vyskočí „+1“ s mincí. Restart relace počet vrátí na 0.
    if (view.served < servedSeen.current) servedSeen.current = view.served;
    const player = state[HEADER.player] as number;
    const pb = bodyBase(player);
    for (; servedSeen.current < view.served; servedSeen.current += 1) {
      const free = pluses.current.reduce((oldest, plus) => (plus.start < oldest.start ? plus : oldest));
      free.start = now;
      free.group?.position.set(m(state[pb + BODY.x] as number), PLUS.y, m(state[pb + BODY.z] as number));
    }
    for (const plus of pluses.current) {
      if (plus.group === null) continue;
      const age = now - plus.start;
      plus.group.visible = plus.start >= 0 && age < PLUS.s;
      if (!plus.group.visible) continue;
      // Naskočí s překmitem (`ease-pop`), pak stoupá; při omezeném pohybu jen stojí.
      const pop = reduced ? 1 : Math.min(1, age / PLUS.pop);
      plus.group.scale.setScalar(reduced ? 1 : pop < 1 ? pop * (1 + 0.25 * Math.sin(pop * Math.PI)) : 1);
      plus.group.position.y = PLUS.y + (reduced ? 0 : PLUS.rise * (1 - (1 - age / PLUS.s) ** 2));
    }

    // Stanoviště: naskočení, zboží podle zásoby, pruh pečení, u pultu počet čekajících.
    for (const { cell, kind } of stations) {
      const refs = stationRefs.current.get(cell);
      const body = view.stations[cell] as number;
      if (refs === undefined || body < 0) continue;
      const base = bodyBase(body);
      refs.group?.scale.setScalar(0.6 + 0.4 * Math.min(1, (now - refs.born) / POP_S));
      if (refs.queue !== null && refs.line !== null) {
        const waiting = queueAt(state, cell).length;
        refs.queue.visible = waiting > 0;
        if (waiting > 0) {
          paint(refs.line, String(waiting), (context) => {
            card(context, color.paper, 10);
            words(context, String(waiting), 128, 106, 120, 900, color.ink);
            words(context, 'in line', 128, 208, 44, 700, color.ink);
          });
        }
      }
      const stock = state[base + STATION_SLOTS.stock] as number;
      refs.goods.forEach((goods, k) => {
        if (goods !== null) goods.visible = k < stock;
      });
      if (refs.bake !== null) {
        const baking = stock < BUILDSHIFT.ovenCap;
        refs.bake.parent!.visible = baking;
        const done = clamp01((state[base + STATION_SLOTS.bake] as number) / BUILDSHIFT.bakeTicks);
        refs.bake.scale.x = Math.max(0.001, done);
        refs.bake.position.x = (-(BAR.w - 0.08) / 2) * (1 - done);
      }
    }

    // Prodavač (hrdina): poloha mezi tiky, u stanoviště za ním, čelem po cestě, jinak ke dveřím.
    const sx = lerp(prev[pb + BODY.x] as number, state[pb + BODY.x] as number, alpha);
    const sz = lerp(prev[pb + BODY.z] as number, state[pb + BODY.z] as number, alpha);
    const dx = (state[pb + BODY.x] as number) - (prev[pb + BODY.x] as number);
    const dz = (state[pb + BODY.z] as number) - (prev[pb + BODY.z] as number);
    const seller = sellerMemory.current;
    seller.moving = dx !== 0 || dz !== 0;
    const at = cellAtWorld(state[pb + BODY.x] as number, state[pb + BODY.z] as number);
    const behind = !seller.moving && at >= 0 && (view.stations[at] as number) >= 0 ? BEHIND.z : 0;
    seller.behind = lerp(seller.behind, behind, Math.min(1, delta * BEHIND.ease));
    hero.current?.position.set(m(sx), 0, m(sz) + seller.behind);
    heroYaw.current?.rotation.set(0, seller.moving ? Math.atan2(dx, dz) : 0, 0);
    if (heroInner.current !== null && hero.current !== null) heroInner.current.scale.setScalar(Math.min(1, SELLER_CAP / Math.max(1e-3, hero.current.scale.x)));
    if (carried.current !== null) carried.current.visible = view.carrying > 0;

    // Cíl prodavače.
    if (ring.current !== null) {
      ring.current.visible = view.target >= 0 && view.target < BOARD_CELLS;
      if (ring.current.visible) ring.current.position.set(m(cellX(view.target)), 0.03, m(cellZ(view.target)));
    }

    // Zákazníci: sloty se drží (model se nepřestaví), nový dostane první volný.
    const customers = customersOf(state);
    for (const slot of slots.current) if (slot.body >= 0 && !customers.includes(slot.body)) slot.body = -1;
    for (const body of customers) {
      if (slots.current.some((slot) => slot.body === body)) continue;
      const free = slots.current.find((slot) => slot.body < 0);
      if (free !== undefined) free.body = body;
    }
    let waiting = 0;
    slots.current.forEach((slot, index) => {
      const group = customerGroups.current[index];
      if (group === null || group === undefined) return;
      group.visible = slot.body >= 0;
      if (slot.body < 0) return;
      const base = bodyBase(slot.body);
      const x0 = prev[base + BODY.x] as number;
      const z0 = prev[base + BODY.z] as number;
      const x1 = state[base + BODY.x] as number;
      const z1 = state[base + BODY.z] as number;
      // Nový zákazník (skok ze dveří nebo jiné tělo ve slotu) se neprolíná.
      const jump = Math.abs(x1 - x0) + Math.abs(z1 - z0) > BUILDSHIFT.cell;
      const cx = jump ? x1 : lerp(x0, x1, alpha);
      const cz = jump ? z1 : lerp(z0, z1, alpha);
      slot.moving = !jump && (x1 !== x0 || z1 !== z0);
      const counter = counterOfCustomer(state, slot.body);
      // Kdo nemá pult, čeká u dveří: rozestoupí se, ať nestojí v sobě.
      let ox = 0;
      let oz = 0;
      if (counter < 0) {
        ox = ((waiting % 3) - 1) * 0.6;
        oz = Math.floor(waiting / 3) * 0.5;
        waiting += 1;
      }
      group.position.set(m(cx) + ox, 0, m(cz) + oz);
      const inner = customerInner.current[index];
      if (inner !== null && inner !== undefined) {
        let yaw = slot.moving ? Math.atan2(x1 - x0, z1 - z0) : counter >= 0 ? Math.atan2(cellX(counter) - x1, cellZ(counter) - z1) : 0;
        let breath = 1;
        if (!slot.moving && motion) {
          const phase = (now / BREATH.period) * Math.PI * 2 + slot.body * 1.7;
          breath = 1 + BREATH.amount * Math.sin(phase);
          yaw += BREATH.look * Math.sin(phase * 0.37);
        }
        inner.rotation.set(0, yaw, 0);
        inner.scale.set(1, breath, 1);
      }
      const fill = patience.current[index];
      if (fill !== null && fill !== undefined) {
        const arrived = state[base + CUSTOMER_SLOTS.arrived] as number;
        const left = arrived === 0 ? 1 : clamp01(1 - (tick - (arrived - 1)) / BUILDSHIFT.patience);
        fill.scale.x = Math.max(0.001, left);
        fill.position.x = (-(BAR.w - 0.08) / 2) * (1 - left);
        fill.material = left > 0.5 ? materials.calm : left > 0.25 ? materials.warn : materials.urgent;
      }
    });

    // Paleta: vybraný druh vyjede, ceny podle mincí, Open rajčatový jen ve fázi stavby. Nápověda (ťuk bez výběru):
    // karty druhů zežloutnou přes barvu materiálu (bez překreslení textury) a postupně poskočí, pak doběhnou zpět.
    const building = view.phase === PHASE.build;
    const hintAge = now - blink.hint;
    const hint = hintAge >= 0 && hintAge < HINT.s ? Math.min(1, (HINT.s - hintAge) / HINT.fade) : 0;
    STATION_KINDS.forEach((kind, k) => {
      const selected = selectedKind === kind;
      const affordable = view.coins >= STATION_COST[kind];
      const label = labels.palette[k] as Label;
      paint(label, `${selected}|${affordable}`, (context) => {
        card(context, selected ? color.sun : affordable ? color.paper : color['cream-deep'], selected ? 16 : 10);
        coin(context, 200, 56, 34, String(STATION_COST[kind]));
        words(context, STATION_NAME[kind], 128, 216, 44, 700, affordable || selected ? color.ink : color['ink-soft']);
      });
      label.material.color.copy(WHITE).lerp(HINT_TINT, hint);
      const hop = hint > 0 && !reduced ? HINT.hop * Math.max(0, Math.sin(Math.PI * clamp01((hintAge - k * HINT.stagger) / HINT.hopS))) : 0;
      paletteTiles.current[k]?.position.setY((selected ? 0.18 : 0) + hop);
    });
    paint(labels.coins, String(view.coins), (context) => {
      card(context, color.paper, 10);
      coin(context, 74, 108, 40, '');
      words(context, String(view.coins), 170, 112, 96, 900, color.ink);
      words(context, 'Coins', 128, 216, 44, 700, color.ink);
    });
    paint(labels.open, String(building), (context) => {
      card(context, building ? color.tomato : color['cream-deep'], building ? 14 : 10);
      words(context, 'Open', 128, 120, 72, 900, building ? color.ink : color['ink-soft']);
    });
    if (openBar.current !== null) {
      openBar.current.parent!.visible = building;
      const left = clamp01(1 - tick / BUILDSHIFT.buildTicks);
      openBar.current.scale.x = Math.max(0.001, left);
      openBar.current.position.x = (-(1.5 - 0.08) / 2) * (1 - left);
    }
    paint(labels.served, `${view.served}/${goal}`, (context) => {
      card(context, color.paper, 10);
      words(context, 'Served', 128, 62, 44, 700, color.ink);
      words(context, `${view.served}/${goal}`, 128, 160, 88, 900, color.ink);
    });
    // Rush (posledních 15 s hodin): cedule místo květináče, tepe jen bez omezeného pohybu.
    const rushing = tick >= rushFrom && view.phase === PHASE.open && state[HEADER.runState] === RUN_STATE.running;
    if (rushSign.current !== null && pot.current !== null) {
      rushSign.current.visible = rushing;
      pot.current.visible = !rushing;
      rushSign.current.scale.setScalar(rushing && motion ? 1 + RUSH_PULSE.amount * Math.sin((now / RUSH_PULSE.period) * Math.PI * 2) : 1);
    }

    const host = surface.current;
    if (host === null) return;
    if (host.dataset.laneCells !== placed.attr) host.dataset.laneCells = placed.attr;
    // Kreslené x je zrcadlené (skupina desky je otočená o π).
    host.dataset.playerX = probe.set(-m(sx), SELLER.h, -(m(sz) + seller.behind)).project(camera).x.toFixed(3);
  });

  const heroRig = riggedCharacter(cast.player);
  return (
    <>
      <FieldGround look={look} area={LAND} y={-0.03} />
      <group rotation={[0, Math.PI, 0]}>
        {/* Podklad desky a palety: mezery mezi dlaždicemi jsou hranice buněk. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, (BACK_Z + FRONT_Z) / 2]} receiveShadow>
          <planeGeometry args={[2 * HALF, FRONT_Z - BACK_Z]} />
          <meshStandardMaterial color={color['ink-soft']} roughness={1} />
        </mesh>
        <primitive object={floor.mesh} />
        {/* Nízké stěny: zadní a boční; přední zeď jsou buňky 25 a 29 vedle dveří. */}
        <mesh position={[0, WALL.h / 2, BACK_Z - WALL.t / 2]} castShadow receiveShadow>
          <boxGeometry args={[2 * HALF + 2 * WALL.t, WALL.h, WALL.t]} />
          <meshStandardMaterial color={color['sky-deep']} roughness={0.8} />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * (HALF + WALL.t / 2), WALL.h / 2, BACK_Z + (BUILDSHIFT.rows * CELL) / 2]} castShadow receiveShadow>
            <boxGeometry args={[WALL.t, WALL.h, BUILDSHIFT.rows * CELL]} />
            <meshStandardMaterial color={color['sky-deep']} roughness={0.8} />
          </mesh>
        ))}
        {BUILDSHIFT.walls.map((cell) => (
          <group key={cell} position={[m(cellX(cell)), 0, m(cellZ(cell))]}>
            <mesh position={[0, WALL.block / 2, 0]} castShadow receiveShadow>
              <boxGeometry args={[TILE, WALL.block, TILE]} />
              <meshStandardMaterial color={color['sky-deep']} roughness={0.8} />
            </mesh>
            {cell === BUILDSHIFT.walls[0] ? (
              // Cedule Served: počet obsloužených a cíl, plochá na zdi.
              <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, WALL.block + 0.01, 0]} material={labels.served.material} userData={{ item: 'served' }}>
                <planeGeometry args={[TILE - 0.1, TILE - 0.1]} />
              </mesh>
            ) : (
              <>
                {/* Květináč na druhé zdi; v rushi místo něj cedule Rush!. */}
                <group ref={pot} position={[0, WALL.block, 0]}>
                  <mesh position={[0, 0.2, 0]} castShadow>
                    <cylinderGeometry args={[0.35, 0.28, 0.4, 12]} />
                    <meshStandardMaterial color={color['cream-deep']} roughness={0.8} />
                  </mesh>
                  <mesh position={[0, 0.7, 0]} castShadow>
                    <sphereGeometry args={[0.5, 14, 10]} />
                    <meshStandardMaterial color={color['mint-deep']} roughness={0.9} />
                  </mesh>
                </group>
                <group ref={rushSign} position={[0, WALL.block + 0.01, 0]} visible={false} userData={{ item: 'rush' }}>
                  <mesh rotation={[-Math.PI / 2, 0, 0]} material={labels.rush.material}>
                    <planeGeometry args={[TILE - 0.1, TILE - 0.1]} />
                  </mesh>
                </group>
              </>
            )}
          </group>
        ))}
        {/* Za zadní stěnou zázemí obchodu: na výšku vyplní místo nad deskou. */}
        {[-3.4, 0, 3.4].map((x) => (
          <group key={x} position={[x, 0, BACK_Z - 1.2]}>
            <FittedModel id={x === 0 ? 'gen3d-bread-rack' : 'cc0-kitchencabinet'} w={2.6} h={1.6} d={1.2} fallback={color['cream-deep']} />
          </group>
        ))}

        {/* Paleta: tři druhy stanovišť s cenou, mince, Open. */}
        {STATION_KINDS.map((kind, k) => (
          <group
            key={kind}
            ref={(group) => {
              paletteTiles.current[k] = group;
            }}
            position={[m(cellX(PALETTE[kind])), 0, m(cellZ(PALETTE[kind]))]}
            userData={{ item: `palette-${kind}` }}
          >
            <mesh position={[0, 0.08, 0]} castShadow receiveShadow>
              <boxGeometry args={[TILE, 0.16, TILE]} />
              <meshStandardMaterial color={color.ink} roughness={0.9} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.165, 0]} material={labels.palette[k]!.material}>
              <planeGeometry args={[TILE - 0.04, TILE - 0.04]} />
            </mesh>
            <group position={[-0.1, 0.17, -0.15]}>
              <FittedModel id={STATION_MODEL[kind]} w={1.0} h={0.75} d={1.0} fallback={STATION_TINT[kind]} />
            </group>
          </group>
        ))}
        <group position={[m(cellX(PALETTE.coins)), 0, m(cellZ(PALETTE.coins))]} userData={{ item: 'coins' }}>
          <mesh position={[0, 0.08, 0]} castShadow receiveShadow>
            <boxGeometry args={[TILE, 0.16, TILE]} />
            <meshStandardMaterial color={color.ink} roughness={0.9} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.165, 0]} material={labels.coins.material}>
            <planeGeometry args={[TILE - 0.04, TILE - 0.04]} />
          </mesh>
        </group>
        <group position={[m(cellX(PALETTE.open)), 0, m(cellZ(PALETTE.open))]} userData={{ item: 'open' }}>
          <mesh position={[0, 0.08, 0]} castShadow receiveShadow>
            <boxGeometry args={[TILE, 0.16, TILE]} />
            <meshStandardMaterial color={color.ink} roughness={0.9} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.165, 0]} material={labels.open.material}>
            <planeGeometry args={[TILE - 0.04, TILE - 0.04]} />
          </mesh>
          {/* Okno stavby: pruh ubývá, po něm se obchod otevře sám. */}
          <group rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.17, 0.55]}>
            <mesh>
              <planeGeometry args={[1.5, 0.2]} />
              <meshBasicMaterial color={color.ink} toneMapped={false} />
            </mesh>
            <mesh ref={openBar} position={[0, 0, 0.005]} material={materials.bake}>
              <planeGeometry args={[1.5 - 0.08, 0.12]} />
            </mesh>
          </group>
        </group>

        {/* Probliknutí odmítnutého ťuku a kroužek cíle prodavače. */}
        <mesh ref={flash} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
          <planeGeometry args={[CELL - 0.02, CELL - 0.02]} />
          <meshBasicMaterial color={color.alarm} toneMapped={false} />
        </mesh>
        <group ref={ring} visible={false}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.72, 0.88, 32]} />
            <meshBasicMaterial color={color.sun} toneMapped={false} />
          </mesh>
        </group>
        {/* Cenovka nad odmítnutou buňkou a výskoky „+1“, čelem ke kameře. */}
        <group ref={price} visible={false} userData={{ item: 'price' }}>
          <mesh rotation={[-VIEW.pitch, 0, 0]} material={labels.price.material}>
            <planeGeometry args={[SIGN.price, SIGN.price]} />
          </mesh>
        </group>
        {pluses.current.map((plus, index) => (
          <group
            key={index}
            ref={(group) => {
              plus.group = group;
            }}
            visible={false}
            userData={{ item: 'plus' }}
          >
            <mesh rotation={[-VIEW.pitch, 0, 0]} material={labels.plus.material}>
              <planeGeometry args={[SIGN.plus, SIGN.plus]} />
            </mesh>
          </group>
        ))}

        {stations.map(({ cell, kind }) => {
          const refs = stationRefs.current.get(cell);
          return (
            <group
              key={cell}
              ref={(group) => {
                if (refs !== undefined) refs.group = group;
              }}
              position={[m(cellX(cell)), 0, m(cellZ(cell))]}
              userData={{ item: 'station', station: kind }}
            >
              <FittedModel id={STATION_MODEL[kind]} w={STATION_SIZE.w} h={STATION_SIZE.h} d={STATION_SIZE.d} fallback={STATION_TINT[kind]} />
              {GOODS_SPOTS[kind].map((x, k) => (
                <group
                  key={k}
                  ref={(group) => {
                    if (refs !== undefined) refs.goods[k] = group;
                  }}
                  position={[x, STATION_SIZE.h, 0]}
                  visible={false}
                >
                  <FittedModel id={goodsModel} w={GOODS.w} h={GOODS.h} d={GOODS.d} fallback={color.sun} />
                </group>
              ))}
              {kind === 'oven' ? (
                <Bar
                  y={STATION_SIZE.h + 0.45}
                  material={materials.bake}
                  fill={(mesh) => {
                    if (refs !== undefined) refs.bake = mesh;
                  }}
                />
              ) : null}
              {refs?.line != null ? (
                // Počet čekajících leží na pultu (nad pultem by zakryl stanoviště za ním).
                <mesh
                  ref={(mesh) => {
                    refs.queue = mesh;
                  }}
                  rotation={[-Math.PI / 2, 0, 0]}
                  position={[0, STATION_SIZE.h + 0.02, 0]}
                  material={refs.line.material}
                  visible={false}
                  userData={{ item: 'line' }}
                >
                  <planeGeometry args={[SIGN.queue, SIGN.queue]} />
                </mesh>
              ) : null}
            </group>
          );
        })}

        <group ref={hero} userData={{ frame: 'hero' }}>
          <group ref={heroInner}>
            <group ref={heroYaw}>
              {heroRig !== undefined ? (
                <RiggedModel character={heroRig} h={SELLER.h} clip={() => (sellerMemory.current.moving ? 'run' : 'idle')} fallback={color['sky-deep']} />
              ) : (
                <FittedModel id={cast.player} w={SELLER.w} h={SELLER.h} d={SELLER.d} fallback={color['sky-deep']} character />
              )}
              <group ref={carried} position={[0, SELLER.h * 0.6, 0.55]} visible={false} userData={{ item: 'goods' }}>
                <FittedModel id={goodsModel} w={GOODS.w} h={GOODS.h} d={GOODS.d} fallback={color.sun} />
              </group>
            </group>
          </group>
        </group>

        {Array.from({ length: POOL }, (_, index) => (
          <group
            key={index}
            ref={(group) => {
              customerGroups.current[index] = group;
            }}
            visible={false}
            userData={{ item: 'customer' }}
          >
            <group
              ref={(group) => {
                customerInner.current[index] = group;
              }}
            >
              <Figure model={customerModel} size={CUSTOMER} tint={color.bubblegum} moving={() => slots.current[index]?.moving === true} />
            </group>
            <Bar
              y={CUSTOMER.h + 0.4}
              material={materials.calm}
              fill={(mesh) => {
                patience.current[index] = mesh;
              }}
            />
          </group>
        ))}
      </group>
    </>
  );
}
