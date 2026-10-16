'use client';

import { renderHeld } from '../effects/render-feel';

/**
 * Scéna arény (P25F T6): kamera shora nad hráčem, velikosti na první pohled.
 * Každé tělo je kotouč o průměru své šířky; barva říká, co s ním: hráč
 * modrý, menší buňka zelená (sníst), větší červená (utéct), potrava žlutá.
 * Barva i velikost se čtou z každého tiku – hráč roste a buňka, kterou
 * přerostl, zezelená.
 *
 * Směry: kamera kouká dolů s „nahoru“ = +z, `x` jádra je zrcadlené jako
 * u ostatních scén, takže vpravo na obrazovce = +x jádra, nahoru = +z.
 * Vstup: šipky/WASD (i šikmo) a tah prstem od místa stisku = směr pohybu.
 *
 * Dvorek pravidel (P29A T6): věci pravidel (`thing:<id>`) a ploty jsou
 * kvádry w×h×d, výška se čte ze stavu – nesená věc jede hráči na hlavě,
 * hozená letí nad zemí, přepnuté dveře zmizí. Mezerník / ťuk = akce,
 * `e` = druhá akce.
 *
 * Útěk, sběr a souboj (P32E T5) mají scénu ve stylu B (`StyledWorld`): podlaha
 * a stěny podle sady (`ArenaFloor`), modely z popisků rolí, zářící sběratelné
 * věci, vykřičník nad pronásledovatelem při probuzení a nad soupeřem v telegrafu
 * a kamera 3/4 shora s předstihem, která ukáže hráče i nejbližší hrozbu. Světla
 * a obloha jsou rigu (`StyleRig` v `ArcadeStage`), částice a otřes sběrnice
 * efektů (`Effects`). Agar zůstává kotouči, jak ho znají uložené hry.
 *
 * Souboj (P32E T6) čte zásahy ze stavu (`FightFx`): srpek švihu, záblesk,
 * hit-stop jen v kresbě, otřes, lišty HP nad hlavami i pro čtečku, nápřah
 * soupeře zákonem a červení, KO klipem `die` nebo pádem.
 */

import { Billboard } from '@react-three/drei/core/Billboard';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Color, type Group, type Material, type Mesh, type MeshStandardMaterial, type PerspectiveCamera, Vector3 } from 'three';

import { color as brand } from '@/brand/tokens';
import { baseControlOf } from '@/play/arcade/addons';
import { ARCADE_HZ, BODY, BUTTON, FLAG, HEADER, ROLE, UNIT, bodyBase, bodyHp } from '@/play/arcade/contract';
import { instantiate } from '@/play/arcade/kernel';
import type { Look } from '@/play/arcade/look';
import { riggedCharacter } from '@/play/arcade/models';
import { type ClipState, type Pose, clipOf, posesOf, viewOf } from '@/play/arcade/motion';
import { DIRECTIONS, arenaAxis, graceLeft } from '@/play/arcade/pieces/arena';
import { FIGHT, FIGHT_PHASE, attackCooldownOf, facingOf, phaseOf, phaseTicksLeft, strikeDirectionOf } from '@/play/arcade/pieces/fight';
import { type ToyPose, toyPoseOf, toyViewOf } from '@/play/arcade/toy-motion';
import type { HeroAction } from '@/play/spec';

import { type BodyView, PACING_KINDS, SPARK_KIND, bodiesOf, bodiesStale } from '../bodies';
import { type ArcadeGhost, GhostSlot } from '../GhostSlot';
import { isTyping } from '../input';
import { FieldGround } from '../look/FieldGround';
import { boxEdge } from '../look/ground';
import { glowingCopy } from '../look/load';
import { applyIntro, introLeft, useIntroClock } from '../look/intro';
import { Scenery } from '../look/Scenery';
import { VegetationAround } from '../look/Vegetation';
import { LOW_TOWARD_CAMERA } from '../look/vegetation-places';
import { questTargets } from '../quest/TargetStates';
import { RiggedModel, type ToyFrame } from '../RiggedModel';
import type { ArcadeSession } from '../session';
import { HeroActionBody } from '../hero-action/HeroActionBody';
import { InkOutline } from '../look/rig/InkOutline';
import { applyToy, toyMotionOn, toyTickOf } from '../toy/applyToy';
import { bodyClassOf } from '../toy/body-class';
import { type Cast, FittedModel, toyTargetOf } from '../World';
import { ArenaFloor } from './ArenaFloor';
import { type TargetLayer, TargetsMount } from './TargetsMount';
import { useThreatEdge } from './ThreatEdge';
import { ALERT_ABOVE_BAR_M, type Fighter, HealthBar, type HealthBarHandle, type MeterFighter, SwingArc, adoptSkin, advanceFrame, createFightWatch, drawFighter, drawSwing, fightClipOf, fighterName, shakeCamera, useHealthMeters } from './FightFx';

const COLOR = { player: '#2563eb', prey: '#16a34a', hunter: '#dc2626', food: '#facc15', shot: '#f8fafc' } as const;

/** Barva kotouče při stavbě scény; nepřítel ji podle velikosti mění každý tik, pronásledovatel `+chaser` je vždy k útěku. */
const colorOf = (role: number): string =>
  role === ROLE.player ? COLOR.player : role === ROLE.collectible ? COLOR.food : role === ROLE.chaser ? COLOR.hunter : role === ROLE.projectile ? COLOR.shot : COLOR.prey;

const ROLE_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(ROLE).map(([name, code]) => [code, name]));

/** Věci pravidel: jantar, tyrkys, oranžová, nebeská, hnědá, břidlice – ne zelená kořist, ne fialová. */
const THING_COLORS = ['#f59e0b', '#14b8a6', '#f97316', '#38bdf8', '#a16207', '#64748b'] as const;
const FENCE_COLOR = '#78716c';

/** Id role pravidla z druhu `thing:<id>`, jinak `null`. */
const thingOf = (kind: string): string | null => (kind.startsWith('thing:') ? kind.slice(6) : null);

/** Stálá barva podle jména role – tatáž věc má tutéž barvu v každé hře. */
function thingColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return THING_COLORS[hash % THING_COLORS.length] as string;
}

/** Nad zemí víc než tohle (m) = ve vzduchu (sonda `data-airborne`). */
const AIRBORNE_M = 0.05;

/** Kolik metrů od hráče do strany je vidět vždy. */
const SEE_M = 9;
/** Na výšku (mobil) méně: při 6 m měl hráč 3,7 % výšky obrazu (P27A T6, P30B T5); nahoru a dolů je pak vidět víc. */
const SEE_M_TALL = 5;

/** Jak daleko za hranou arény stojí první řada kulis (m); tamtéž začíná vegetace (P46G T7). */
const SCENERY_MARGIN = 1.5;
/** Kam zem agaru sahá za hranu (m): za kulisy do mlhy. */
const AGAR_LAND_M = 50;

/** Sklon kamery nad vodorovnou (rad): 48° – hrdina pořád zřetelně shora, horní třetina obrazu už za hranou arény (58° ukázalo kulisy jen v rozích). */
const PITCH = (48 * Math.PI) / 180;

interface ArenaWorldProps {
  readonly session: ArcadeSession;
  readonly half: number;
  readonly surface: React.RefObject<HTMLDivElement | null>;
  readonly look: Look;
  /** Modely z popisků rolí; agar je nekreslí. */
  readonly cast: Cast;
  /** Vrstva cílů (P32-0 T5, naplní P32G): živé cíle v metrech scény se stavem (`TargetsMount`); bez ní ve stylu B obrysy, agar jen přidá. */
  readonly targets?: TargetLayer;
  /** Viditelná činnost hrdiny (P37-0 T2); stanoviště úkolu ji dostane přes `questTargets`. */
  readonly heroAction: HeroAction;
  /** Duch dřívějšího běhu (P37B T8); aréna kreslí hrdinu převodem `World`, slot tedy výchozím. */
  readonly ghost?: ArcadeGhost;
}

/**
 * Útěk a sběr nesou pevnou velikost hráče (`size`), souboj vlastní ovládání;
 * agar `size` nikdy nemá, takže uložené hry kreslí dál kotouči.
 */
export function ArenaWorld(props: ArenaWorldProps) {
  const control = baseControlOf(props.session.world.control);
  const assembled = props.session.world.kinds?.some(kind => kind.startsWith('thing:part_'));
  return control.id === 'fight' || control.params.size !== undefined || assembled ? <StyledWorld {...props} /> : <AgarWorld {...props} />;
}

function AgarWorld({ session, half, surface, look: scene, targets, ghost }: ArenaWorldProps) {
  // Střely doplňku `+shoot` přidává jádro za běhu (`spawn`) – seznam se staví znovu, když se změní.
  const [discs, setDiscs] = useState(() => bodiesOf(session));
  const groups = useRef<(Group | null)[]>([]);
  const materials = useRef<(MeshStandardMaterial | null)[]>([]);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look = useMemo(() => new Vector3(), []);
  const projected = useMemo(() => new Vector3(), []);
  const introClock = useIntroClock();

  // Role kreslených kotoučů pro e2e (jako `data-drawn` ostatních scén).
  useEffect(() => {
    if (surface.current !== null) surface.current.dataset.drawn = [...new Set(discs.map((disc) => ROLE_NAMES[disc.role]))].join(' ');
  }, [discs, surface]);

  // Pohled shora potřebuje „nahoru“ = +z; ostatní scény počítají s +y.
  useEffect(() => {
    camera.up.set(0, 0, 1);
    return () => {
      camera.up.set(0, 1, 0);
    };
  }, [camera]);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    if (bodiesStale(discs, session)) setDiscs(bodiesOf(session));
    const state = session.state();
    const prev = session.prev();
    const player = state[HEADER.player] as number;
    const mine = state[bodyBase(player) + BODY.w] as number;
    for (const disc of discs) {
      const group = groups.current[disc.index];
      if (group === null || group === undefined) continue;
      const base = bodyBase(disc.index);
      group.visible = ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;
      if (!group.visible) continue;
      const px = prev[base + BODY.x] as number;
      const pz = prev[base + BODY.z] as number;
      const py = prev[base + BODY.y] as number;
      group.position.set(-(px + ((state[base + BODY.x] as number) - px) * alpha) / UNIT, (py + ((state[base + BODY.y] as number) - py) * alpha) / UNIT, (pz + ((state[base + BODY.z] as number) - pz) * alpha) / UNIT);
      const w = state[base + BODY.w] as number;
      group.scale.set(w / UNIT / disc.w, 1, w / UNIT / disc.w);
      const material = materials.current[disc.index];
      if (material !== null && material !== undefined && disc.role === ROLE.enemy) material.color.set(w > mine ? COLOR.hunter : COLOR.prey);
    }
    // Sonda pro e2e ze skupin, které opravdu kreslíme: nesená věc nad zemí, počty viditelných věcí, věci v letu.
    if (surface.current !== null) {
      const heldIndex = (state[HEADER.held] as number) - 1;
      const counts = new Map<string, number>();
      const airborne: string[] = [];
      let held = '';
      for (const disc of discs) {
        const id = thingOf(disc.kind);
        const group = groups.current[disc.index];
        if (id === null || group === null || group === undefined || !group.visible) continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
        if (group.position.y <= AIRBORNE_M) continue;
        if (disc.index === heldIndex) held = id;
        else airborne.push(id);
      }
      const dataset = surface.current.dataset;
      const things = [...counts].map(([id, n]) => `${id}:${n}`).join(' ');
      if (dataset.held !== held) dataset.held = held;
      if (dataset.things !== things) dataset.things = things;
      if (dataset.airborne !== airborne.join(' ')) dataset.airborne = airborne.join(' ');
    }
    const me = groups.current[player];
    if (me !== null && me !== undefined) {
      // Aspoň `SEE_M` metrů do strany i na výšku (mobil) a výš s velikostí hráče,
      // ať větší buňku vidí dřív, než dojede.
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const distance = Math.max(16, (camera.aspect < 1 ? SEE_M_TALL : SEE_M) / (tan * Math.min(1, camera.aspect))) + (mine / UNIT) * 3;
      // Šikmo zezadu, ne kolmo dolů (P28D T6, F-29): kolmá kamera viděla jen podlahu,
      // takhle horní okraj obrazu sahá za hranu arény na kulisy prostředí.
      camera.position.set(me.position.x, distance * Math.sin(PITCH), me.position.z - distance * Math.cos(PITCH));
      look.set(me.position.x, 0, me.position.z);
      camera.lookAt(look);
      applyIntro(camera, look, introLeft(introClock()));
      camera.updateMatrixWorld();
      if (surface.current !== null) surface.current.dataset.playerX = projected.copy(me.position).project(camera).x.toFixed(3);
    }
  });

  const side = (2 * half) / UNIT;
  // Zem za hranou s odstíny, skvrnami, krajnicí u hrany a tmavnutím do dálky (P46G T7); vegetace sady za kulisami.
  const { box, land, edge } = useMemo(() => {
    const field = { x0: -side / 2, x1: side / 2, z0: -side / 2, z1: side / 2 };
    return { box: field, land: { x0: field.x0 - AGAR_LAND_M, x1: field.x1 + AGAR_LAND_M, z0: field.z0 - AGAR_LAND_M, z1: field.z1 + AGAR_LAND_M }, edge: boxEdge(field) };
  }, [side]);
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]}>
        <planeGeometry args={[side, side]} />
        {/* Podlaha v barvě dráhy sady, ne země: zelená kořist by na trávě splynula. Prostředí ukazují kulisy za hranou. */}
        <meshStandardMaterial color={scene.track} roughness={0.8} />
      </mesh>
      <FieldGround look={scene} area={land} edge={edge} y={-0.08} under />
      {/* Kamera pod 48° obzor nevidí: kulisu za mlhou nahrazuje vzdálená linie stromů; na straně kamery jen drobnosti. */}
      {scene.flora !== undefined && <VegetationAround flora={scene.flora} seed={session.world.seed} box={box} clear={SCENERY_MARGIN} layers={LOW_TOWARD_CAMERA} />}
      {/* Kulisy sady prostředí (P27A T3) za hranou arény ze všech čtyř stran – jen vzhled, jádro o nich neví. */}
      {[0, Math.PI / 2].map((turn) => (
        <group key={turn} rotation={[0, turn, 0]}>
          <Scenery look={scene} layout="sides" inner={side / 2 + SCENERY_MARGIN} from={-side / 2} to={side / 2} vegetation />
        </group>
      ))}
      {discs.map((disc) => {
        const thing = thingOf(disc.kind);
        if (thing !== null || disc.role === ROLE.obstacle) {
          return (
            <group key={disc.index} ref={(group) => { groups.current[disc.index] = group; }} userData={{ frame: thing === null ? undefined : 'target' }}>
              <mesh position={[0, disc.h / 2, 0]}>
                <boxGeometry args={[disc.w, disc.h, disc.d]} />
                <meshStandardMaterial ref={(material) => { materials.current[disc.index] = material; }} color={thing === null ? FENCE_COLOR : thingColor(thing)} roughness={0.6} />
              </mesh>
            </group>
          );
        }
        // Jiskra tepu (P47A T10) je bonus, ne věc hry: mátový kotouč místo žlutého.
        const color = disc.role === ROLE.collectible && disc.kind === SPARK_KIND ? brand.mint : colorOf(disc.role);
        const tall = disc.role === ROLE.collectible ? 0.15 : Math.min(0.5, disc.h);
        return (
          // `frame` čte sonda záběru (P27A T6): hráč je hrdina, každý jiný kotouč kromě střely cíl nebo hrozba.
          <group key={disc.index} ref={(group) => { groups.current[disc.index] = group; }} userData={{ frame: disc.role === ROLE.player ? 'hero' : disc.role === ROLE.projectile ? undefined : 'target' }}>
            <mesh position={[0, tall / 2, 0]}>
              <cylinderGeometry args={[disc.w / 2, disc.w / 2, tall, 32]} />
              <meshStandardMaterial ref={(material) => { materials.current[disc.index] = material; }} color={color} roughness={0.5} />
            </mesh>
            {disc.role === ROLE.player && (
              <mesh position={[0, tall + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[disc.w / 2 - 0.08, disc.w / 2, 32]} />
                <meshBasicMaterial color="#f8fafc" />
              </mesh>
            )}
          </group>
        );
      })}
      {targets !== undefined && <TargetsMount session={session} views={discs} layer={targets} />}
      {/* Slot ducha (P37-0 T3). */}
      <GhostSlot ghost={ghost} session={session} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Útěk, sběr a souboj ve stylu B (P32E T5)

/**
 * Hrdina útěku a sběru má tělo 1 × 0,6 m. Kreslí se větší: kamera, která ukáže
 * i pronásledovatele za zády, by ho jinak zmenšila pod 4 % výšky obrazu.
 * Jádro počítá srážky jen v x/z, výška kresby na ně nemá vliv.
 */
const HERO_DRAWN_M = 1.3;
/** Sběratelná věc: velikost kresby, výška vznášení, otáčky (rad/s). */
const ITEM_DRAWN_M = 0.7;
const ITEM_HOVER_M = 0.35;
const ITEM_SPIN = 2;
/** Odstup výzdoby podlahy od těla na startu (m): kamínek u nohy hrdiny ani trs pod věcí. */
const DECOR_KEEP_M = 0.4;
/** Záře věci nad prahem bloomu rigu (`bloomThreshold` ≈ 1,1). */
const ITEM_GLOW = 2.4;
const RING_GLOW = new Color(brand.sun).multiplyScalar(2.5);
/** Kruh pod jiskrou tepu: mátová jako jiskra, ne slunce věcí hry. */
const SPARK_GLOW = new Color(brand.mint).multiplyScalar(2.5);
const ALERT_GLOW = new Color(brand.tomato).multiplyScalar(1.6);

/** Sklon kamery nad vodorovnou (sin, cos). */
interface Tilt {
  readonly sin: number;
  readonly cos: number;
}
const tiltOf = (degrees: number): Tilt => ({ sin: Math.sin((degrees * Math.PI) / 180), cos: Math.cos((degrees * Math.PI) / 180) });
/**
 * Kamera 3/4 shora; předstih = kam hráč dojede za tolik sekund. P35 T2: 50° → 40°.
 * Při 50° byla kočka shora zezadu jen hřbet a uši a astra ji naslepo nepoznala (O10);
 * při 40° je vidět hlava a bok.
 */
const STYLED_TILT = tiltOf(40);
/**
 * Souboj strměji (P32E T6): soupeř jde na hrdinu podél osy kamery a při 50°
 * ho hrdina i jeho lišta HP zakryly, zásah i pád se ztratily za zády.
 */
const FIGHT_TILT = tiltOf(60);
const LEAD_S = 0.35;
/** Hrozba blíž než tolik metrů táhne záběr k sobě, ať je vidět hráč i ona. */
const THREAT_M = 22;
/** Kam do obrazu (NDC) se musí vejít hrdina a nejbližší hrozba. */
const HERO_EDGE = 0.8;
const THREAT_EDGE = 0.9;
/**
 * Hrdina drží aspoň tenhle podíl výšky obrazu – strop vzdálenosti kamery; na výšku (mobil) víc.
 * P35 T2: dřív 5 % všude a hrozba za zády kameru oddálila až k němu (čaroděj 4,7 %, O10).
 * Hrozba, která se do toho nevejde, se ukáže šipkou na okraji (`useThreatEdge`), ne oddálením.
 */
// Kvádr těla je o ~30 % vyšší než model, který do něj sonda záběru měří: 0,085 dalo kočce 6,5 % (1. 10.).
const HERO_SHARE = 0.1;
const HERO_SHARE_TALL = 0.11;
/** Jak rychle kamera dojíždí za cílem (1/s). */
const FOLLOW = 5;
/** Pod touhle rychlostí (jednotek za tik, ~0,5 m/s) tělo stojí a otáčí se k hráči, nebo drží směr. */
const TURN_MIN = 8;
/** Vykřičník svítí posledních tolik tiků ochrany a tolik tiků po probuzení. */
const ALERT_TICKS = 45;
/** Jak často (snímky) se modely věcí, které se mezitím načetly, rozzáří (a bojovníci převezmou materiály). */
const GLOW_EVERY = 20;
/** Nejdelší krok hodin kresby souboje (s): snímek po pauze nepřeskočí záblesk ani pád. */
const MAX_FX_STEP_S = 0.1;

/** `foe` = tělo průběhu P45C (chování, boss): model pronásledovatele z věty, bez vykřičníku a tahu kamery pronásledovatele. */
type Part = 'hero' | 'chaser' | 'enemy' | 'foe' | 'item' | 'block';

export function partOf(view: BodyView): Part {
  if (view.role === ROLE.player) return 'hero';
  if (view.role === ROLE.chaser) return 'chaser';
  if (PACING_KINDS.has(view.kind)) return 'foe';
  if (view.kind === 'enemy' || (view.kind === 'prey' && view.role === ROLE.enemy)) return 'enemy';
  if (view.role === ROLE.collectible) return 'item';
  return 'block';
}

/** Model z popisku role; věc bez modelu (`undefined`) je zářící drahokam. */
export function modelOf(part: Part, cast: Cast): string | undefined {
  return part === 'hero' ? cast.player : part === 'chaser' || part === 'foe' ? cast.chaser : part === 'enemy' ? cast.enemy : part === 'item' ? cast.props.coin : undefined;
}

const FALLBACK: Readonly<Record<Part, string>> = { hero: brand['sky-deep'], chaser: brand.alarm, enemy: brand['tomato-deep'], foe: brand.alarm, item: brand.sun, block: FENCE_COLOR };

interface Size {
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

function drawnOf(view: BodyView, part: Part): Size {
  if (part === 'item') return { w: ITEM_DRAWN_M, h: ITEM_DRAWN_M, d: ITEM_DRAWN_M };
  if (part === 'hero' && view.h < HERO_DRAWN_M) return { w: Math.max(view.w, HERO_DRAWN_M), h: HERO_DRAWN_M, d: Math.max(view.d, HERO_DRAWN_M) };
  return { w: view.w, h: view.h, d: view.d };
}

/** Otočení skupiny (rad kolem y), aby lokální +z mířilo směrem jádra (dx, dz); scéna zrcadlí x. */
const yawOf = (dx: number, dz: number): number => Math.atan2(-dx, dz);

/** Nejmenší vzdálenost kamery od cíle pohledu, aby bod (m vůči cíli, poloměr `r`) promítl do ±`edge` NDC. */
function reachOf(qx: number, qy: number, qz: number, r: number, tan: number, aspect: number, edge: number, tilt: Tilt): number {
  const along = qz * tilt.cos - qy * tilt.sin;
  const up = qy * tilt.cos + qz * tilt.sin;
  return Math.max((Math.abs(qx) + r) / (edge * tan * aspect), (Math.abs(up) + r) / (edge * tan)) - along;
}

/**
 * Hračkový úder (`toyPoseOf`) začne nápřahem dozadu a výpad vrcholí až tolik tiků po začátku.
 * V aréně je nápřahem přiblížení (v souboji telegraf) a rána dopadá v tiku zásahu, takže se
 * začátek posune o tolik tiků zpět: tik zásahu je vrchol výpadu k zasaženému, ne nápřah od něj.
 */
const BLOW_PEAK_TICKS = 16;

/**
 * Tik stavu, kdy tělo udeřilo: hrdina souboje švihem, soupeř souboje svým úderem (oba dopadnou
 * v tiku, kdy začaly), jinak událost `attack` hračkového pohledu; `null` = neudeřilo.
 */
function blowOf(state: Int32Array, index: number, part: Part, fighter: boolean, attack: boolean): number | null {
  const tick = state[HEADER.tick] as number;
  if (fighter && part === 'hero') {
    const left = attackCooldownOf(state, index);
    return left > 0 ? tick - (FIGHT.attackCooldown - left) : null;
  }
  if (fighter) return phaseOf(state, index) === FIGHT_PHASE.strike ? tick - (FIGHT.strike - phaseTicksLeft(state, index)) : null;
  return attack ? tick : null;
}

/** Zářící kopie materiálu modelu věci – jedna na zdrojový materiál, sdílená všemi věcmi. */
function glowOf(cache: Map<Material, Material>, source: Material): Material {
  let glow = cache.get(source);
  if (glow === undefined) {
    glow = glowingCopy(source, ITEM_GLOW);
    cache.set(source, glow);
  }
  return glow;
}

function Gem({ size }: { readonly size: number }) {
  return (
    <mesh position={[0, size / 2, 0]} userData={{ glow: true }}>
      <octahedronGeometry args={[size / 2, 0]} />
      <meshStandardMaterial color={brand.sun} emissive={brand.sun} emissiveIntensity={ITEM_GLOW} roughness={0.3} flatShading />
    </mesh>
  );
}

/** Jiskra tepu (P47A T10): tři zkřížené hroty v mátové – bonus, ne věc hry (ta je drahokam nebo model z věty). Nic nestahuje. */
const SPARK_ARMS: readonly (readonly [number, number, number])[] = [[0.3, 1, 0.3], [1, 0.3, 0.3], [0.3, 0.3, 1]];
function Spark({ size }: { readonly size: number }) {
  return (
    <group position={[0, size / 2, 0]}>
      {SPARK_ARMS.map((scale) => (
        <mesh key={scale.join()} scale={[...scale]} userData={{ glow: true }}>
          <octahedronGeometry args={[size / 2, 0]} />
          <meshStandardMaterial color={brand.mint} emissive={brand.mint} emissiveIntensity={ITEM_GLOW} roughness={0.3} flatShading />
        </mesh>
      ))}
    </group>
  );
}

/** Vykřičník nad hlavou: sloupek a tečka čelem ke kameře – svislý kvádr by z 3/4 shora splynul v šikmou čárku. Stín nevrhá. */
function Alert({ at, register }: { readonly at: number; readonly register: (group: Group | null) => void }) {
  return (
    <Billboard ref={register} position={[0, at, 0]} visible={false}>
      <mesh position={[0, 0.62, 0]} userData={{ rigShadow: 'off' }}>
        <planeGeometry args={[0.3, 0.8]} />
        <meshBasicMaterial color={ALERT_GLOW} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.02, 0]} userData={{ rigShadow: 'off' }}>
        <circleGeometry args={[0.18, 20]} />
        <meshBasicMaterial color={ALERT_GLOW} toneMapped={false} />
      </mesh>
    </Billboard>
  );
}

function StyledWorld({ session, half, surface, look: scene, cast, targets, heroAction, ghost }: ArenaWorldProps) {
  const [views, setViews] = useState(() => bodiesOf(session));
  const fight = useMemo(() => baseControlOf(session.world.control).id === 'fight', [session]);
  const parts = useMemo(() => views.map(partOf), [views]);
  const drawn = useMemo(() => views.map((view, i) => drawnOf(view, parts[i]!)), [views, parts]);
  const rigged = useMemo(
    () =>
      parts.map((part) => {
        const id = part === 'item' ? undefined : modelOf(part, cast);
        return id === undefined ? undefined : riggedCharacter(id);
      }),
    [parts, cast],
  );
  const groups = useRef<(Group | null)[]>([]);
  const turned = useRef<(Group | null)[]>([]);
  const posed = useRef<(Group | null)[]>([]);
  const alerts = useRef<(Group | null)[]>([]);
  const poses = useRef<(Pose | null)[]>([]);
  const clips = useRef<ClipState[]>([]);
  const yaws = useRef<(number | undefined)[]>([]);
  /** Hračková póza (P45D T9) s pamětí minulého snímku a třída těla modelu role. */
  const toyPoses = useRef<(ToyPose | undefined)[]>([]);
  /** Pohled a tik, ze kterých hraje hračku riggovaná postava (T13) – v hit-stopu stojí jako póza modelu. */
  const toyFrames = useRef<(ToyFrame | undefined)[]>([]);
  const bodyClasses = useMemo(() => parts.map((part) => bodyClassOf(modelOf(part, cast) ?? '')), [parts, cast]);
  /** Tik, kdy se probuzený pronásledovatel (kopie od `spawnBase`) poprvé ukázal. */
  const woke = useRef(new Map<number, number>());
  const glows = useMemo(() => new Map<Material, Material>(), []);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const aim = useMemo(() => new Vector3(), []);
  const goal = useMemo(() => new Vector3(), []);
  const projected = useMemo(() => new Vector3(), []);
  const mid = useMemo(() => new Vector3(), []);
  const pointEdge = useThreatEdge(surface);
  const follow = useRef<{ tick: number; distance: number } | null>(null);
  const frames = useRef(0);
  const introClock = useIntroClock();

  // Souboj (P32E T6): hlídka zásahů, hodiny kresby a to, co kreslí z nich.
  const watch = useMemo(() => (fight ? createFightWatch() : null), [fight]);
  const initial = useMemo(() => instantiate(session.world), [session]);
  /** HP na startu (tělo z živé změny: v chvíli, kdy přibylo); 0 = tělo nebojuje. */
  const startHp = useMemo(
    () => views.map((view) => (!fight || (parts[view.index] !== 'hero' && parts[view.index] !== 'enemy') ? 0 : bodyHp(view.index < (initial[HEADER.bodyCount] as number) ? initial : session.state(), view.index))),
    [views, parts, fight, initial, session],
  );
  /** Kam výzdoba podlahy nesmí: každé tělo na startu s odstupem; těla přidaná za hry nesou vlastní záři nad ní. */
  const keep = useMemo(
    () =>
      views
        .filter((view) => view.index < (initial[HEADER.bodyCount] as number))
        .map((view) => {
          const base = bodyBase(view.index);
          const size = drawn[view.index]!;
          return { x: -(initial[base + BODY.x] as number) / UNIT, z: (initial[base + BODY.z] as number) / UNIT, r: Math.max(size.w, size.d) / 2 + DECOR_KEEP_M };
        }),
    [views, drawn, initial],
  );
  const heroHeight = useMemo(() => {
    const hero = parts.indexOf('hero');
    return hero < 0 ? HERO_DRAWN_M : drawn[hero]!.h;
  }, [parts, drawn]);
  const fxClock = useRef(0);
  const leans = useRef<(Group | null)[]>([]);
  const fighters = useRef<(Fighter | undefined)[]>([]);
  const owned = useMemo((): Material[] => [], []);
  const bars = useRef<(HealthBarHandle | null)[]>([]);
  const arc = useRef<Mesh | null>(null);
  const frozen = useRef<Vector3[]>([]);
  const heldFor = useRef(-Infinity);
  const meterFighters = useMemo((): MeterFighter[] => {
    const rivals = views.filter((view) => parts[view.index] === 'enemy' && startHp[view.index]! > 0);
    const hero = fighterName(cast.player, 'hero');
    const rival = fighterName(cast.enemy, 'fighter');
    return views.flatMap((view) => {
      if (startHp[view.index] === 0) return [];
      if (parts[view.index] === 'hero') return [{ index: view.index, label: `${hero.charAt(0).toUpperCase()}${hero.slice(1)}` }];
      return [{ index: view.index, label: `Rival ${rival}${rivals.length > 1 ? ` ${rivals.indexOf(view) + 1}` : ''}` }];
    });
  }, [views, parts, startHp, cast]);
  const meters = useHealthMeters(surface, meterFighters);

  useEffect(
    () => () => {
      for (const glow of glows.values()) glow.dispose();
    },
    [glows],
  );
  useEffect(
    () => () => {
      for (const material of owned) material.dispose();
    },
    [owned],
  );

  useEffect(() => {
    if (surface.current !== null) surface.current.dataset.drawn = [...new Set(views.map((view) => ROLE_NAMES[view.role]))].join(' ');
  }, [views, surface]);

  useFrame((_, delta) => {
    // Hodiny kresby souboje: stojí s pauzou (zastavený snímek drží záblesk i švih); jádro tiká celý čas snímku vždy, hit-stop jen čte stav po tiku.
    const now = session.paused() ? fxClock.current : (fxClock.current += Math.min(delta, MAX_FX_STEP_S) * 1000);
    const alpha = advanceFrame(session, watch, delta * 1000, now);
    if (renderHeld(session)) return;
    if (bodiesStale(views, session)) setViews(bodiesOf(session));
    const state = session.state();
    const prev = session.prev();
    const tick = state[HEADER.tick] as number;
    const restarted = follow.current !== null && tick < follow.current.tick;
    if (restarted) {
      woke.current.clear();
      toyPoses.current = [];
    }
    posesOf(state, prev, poses.current, tick + alpha);
    const reduced = !toyMotionOn();
    const toyTick = toyTickOf(session);
    const player = state[HEADER.player] as number;
    const pb = bodyBase(player);
    const grace = graceLeft(state);
    const spawnBase = state[HEADER.spawnBase] as number;
    const turn = Math.min(1, delta * 12);
    const glowNow = frames.current++ % GLOW_EVERY === 0;
    // Hit-stop: bojovníci stojí v poloze z chvíle zásahu (zachycené prvním snímkem po něm), pak se k živé dotáhnou.
    const hold = watch?.hold(now) ?? 0;
    const capture = watch !== null && hold > 0 && watch.lastHit() !== heldFor.current;
    if (capture) heldFor.current = watch.lastHit();
    let alertsShown = 0;
    let tinted = 0;
    let flashing = 0;
    let down = 0;
    for (const view of views) {
      const group = groups.current[view.index];
      if (group === null || group === undefined) continue;
      const base = bodyBase(view.index);
      group.visible = ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;
      if (!group.visible) continue;
      const px = prev[base + BODY.x] as number;
      const pz = prev[base + BODY.z] as number;
      const py = prev[base + BODY.y] as number;
      group.position.set(-(px + ((state[base + BODY.x] as number) - px) * alpha) / UNIT, (py + ((state[base + BODY.y] as number) - py) * alpha) / UNIT, (pz + ((state[base + BODY.z] as number) - pz) * alpha) / UNIT);
      const part = parts[view.index];
      const fighter = watch !== null && startHp[view.index]! > 0;
      if (fighter && hold > 0) {
        const at = frozen.current[view.index];
        if (at === undefined) frozen.current[view.index] = group.position.clone();
        else {
          if (capture) at.copy(group.position);
          group.position.lerp(at, hold);
        }
      }
      const facing = turned.current[view.index];
      if (part === 'item') {
        group.position.y += ITEM_HOVER_M + 0.08 * Math.sin((tick + alpha) / 20 + view.index);
        if (facing !== null && facing !== undefined) facing.rotation.y += delta * ITEM_SPIN;
        // Model věci se načte později než scéna: jeho materiály rozzáří až tahle kontrola.
        if (glowNow) {
          group.traverse((node) => {
            const mesh = node as Mesh;
            if (mesh.isMesh !== true || mesh.userData.glow === true) return;
            mesh.material = Array.isArray(mesh.material) ? mesh.material.map((material) => glowOf(glows, material)) : glowOf(glows, mesh.material);
            mesh.userData.glow = true;
          });
        }
        continue;
      }
      const pose = poses.current[view.index];
      const inner = posed.current[view.index];
      // Hračková póza (P45D T9) podle stavu a třídy těla. Hit-stop drží pózu z chvíle zásahu: snímek, který
      // zásah zachytil, ji ještě spočítá, další stojí, dokud hit-stop nepovolí.
      if (!(fighter && hold === 1 && !capture)) {
        const seen = toyViewOf(state, prev, view.index);
        // Bojovníka zasáhne úbytek HP; KO kreslí `drawFighter` na hodinách kresby (poslední úder zastaví tiky), hračka ho nechá stát.
        const moving = fighter ? { ...seen, attack: false, alive: true, hit: seen.hit || bodyHp(state, view.index) < bodyHp(prev, view.index) } : { ...seen, attack: false };
        const blow = blowOf(state, view.index, part!, fighter, seen.attack);
        // Riggovaná postava hraje tenhle pohled jen ve stavech bez klipu (`RiggedModel`, T13); posunutý začátek
        // úderu dostane s ním, ať i její výpad vrcholí v tiku zásahu (T23).
        toyFrames.current[view.index] = blow === null ? { view: moving, tick: toyTick } : { view: moving, tick: toyTick, attackAt: blow - BLOW_PEAK_TICKS };
        if (inner !== null && inner !== undefined) {
          const before = toyPoses.current[view.index] ?? null;
          const memory = blow === null || before === null || before.attackAt === blow - BLOW_PEAK_TICKS ? before : { ...before, attackAt: blow - BLOW_PEAK_TICKS };
          const toy = toyPoseOf(moving, bodyClasses[view.index]!, memory, toyTick, reduced);
          toyPoses.current[view.index] = toy;
          applyToy(toyTargetOf(inner), toy, drawn[view.index]!.h);
          // Zásah bojovníka ukáže záblesk barvy (`drawFighter`); model by blikáním záblesk schoval.
          if (fighter) inner.visible = true;
        }
      }
      if (rigged[view.index] !== undefined && pose !== null && pose !== undefined) {
        const moving = clipOf(viewOf(state, prev, view.index), pose, tick + alpha);
        clips.current[view.index] = fighter ? fightClipOf(state, view.index, part === 'hero', watch, now, moving) : moving;
      }
      // Během hit-stopu stojí i otočení bojovníka.
      if (facing !== null && facing !== undefined && part !== 'block' && !(fighter && hold === 1)) {
        // Kam tělo míří (osy jádra): hrdina souboje pohledem, soupeř v telegrafu a výpadu zamčeným směrem, jinak pohybem; stojící hrozba hledí na hráče.
        const vx = state[base + BODY.vx] as number;
        const vz = state[base + BODY.vz] as number;
        const phase = part === 'enemy' && fight ? phaseOf(state, view.index) : null;
        const locked = phase === FIGHT_PHASE.telegraph || phase === FIGHT_PHASE.strike ? DIRECTIONS[strikeDirectionOf(state, view.index)] : undefined;
        const aimed = part === 'hero' && fight ? DIRECTIONS[facingOf(state, player)] : undefined;
        // Odhozený a poražený soupeř hledí na hrdinu: letí a padá na záda, ne k němu.
        const reeling = phase === FIGHT_PHASE.stagger || (fighter && bodyHp(state, view.index) === 0);
        const heading =
          locked ?? aimed ?? (Math.hypot(vx, vz) > TURN_MIN && !reeling ? { dx: vx, dz: vz } : part === 'hero' ? undefined : { dx: (state[pb + BODY.x] as number) - (state[base + BODY.x] as number), dz: (state[pb + BODY.z] as number) - (state[base + BODY.z] as number) });
        const was = yaws.current[view.index];
        if (heading !== undefined && (heading.dx !== 0 || heading.dz !== 0)) {
          const want = yawOf(heading.dx, heading.dz);
          yaws.current[view.index] = was === undefined || restarted ? want : was + Math.atan2(Math.sin(want - was), Math.cos(want - was)) * turn;
        }
        facing.rotation.y = yaws.current[view.index] ?? 0;
      }
      const alert = alerts.current[view.index];
      if (alert !== null && alert !== undefined) {
        // Spící pronásledovatel (šablona pod `spawnBase`) se chystá, probuzená kopie právě vyrazila; soupeř souboje chystá úder.
        if (part === 'chaser' && view.index >= spawnBase && !woke.current.has(view.index)) woke.current.set(view.index, tick);
        const on =
          part === 'chaser'
            ? view.index < spawnBase
              ? grace > 0 && grace <= ALERT_TICKS
              : tick - (woke.current.get(view.index) ?? tick) < ALERT_TICKS
            : fight && phaseOf(state, view.index) === FIGHT_PHASE.telegraph;
        alert.visible = on;
        if (on) {
          alertsShown += 1;
          alert.scale.setScalar(1 + 0.15 * Math.sin((tick + alpha) / 3));
        }
      }
      if (fighter) {
        // Materiály se převezmou, až se model načte; do té doby kreslí náhradní kvádr, i ten bliká.
        const lean = leans.current[view.index];
        if (lean !== null && lean !== undefined) {
          let drawnFighter = fighters.current[view.index];
          if (drawnFighter?.lean !== lean) {
            const character = rigged[view.index];
            drawnFighter = { lean, skin: [], hero: part === 'hero', rigged: character !== undefined, falls: character?.clips.die === undefined };
            fighters.current[view.index] = drawnFighter;
          }
          if (glowNow || drawnFighter.skin.length === 0) adoptSkin(drawnFighter, owned);
          const look = drawFighter(drawnFighter, state, view.index, alpha, watch, now);
          if (look.tinted) tinted += 1;
          if (look.flashing) flashing += 1;
          if (look.down) down += 1;
        }
        bars.current[view.index]?.set(watch.hp(view.index));
      }
    }
    if (surface.current !== null && surface.current.dataset.alerts !== String(alertsShown)) surface.current.dataset.alerts = String(alertsShown);
    if (watch !== null) {
      const swinging = arc.current !== null && drawSwing(arc.current, watch.swing(now));
      meters.current?.(watch);
      // Sonda pro e2e: kolik soupeřů rudne nápřahem, kolik těl bliká, kolik jich leží, zásahy od restartu a švih.
      const probe = `tinted:${tinted} flashing:${flashing} down:${down} hits:${watch.hits()} swing:${swinging ? 1 : 0}`;
      if (surface.current !== null && surface.current.dataset.fight !== probe) surface.current.dataset.fight = probe;
    }

    const me = groups.current[player];
    if (me === null || me === undefined) return;
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const aspect = camera.aspect;
    // Cíl pohledu: kam hráč dojede za `LEAD_S`, a když je hrozba blízko a vejde se, půl cesty k ní.
    const speed = ARCADE_HZ / UNIT;
    goal.set(me.position.x - (state[pb + BODY.vx] as number) * speed * LEAD_S, 0, me.position.z + (state[pb + BODY.vz] as number) * speed * LEAD_S);
    let threat = -1;
    let nearest = Infinity;
    for (const view of views) {
      if (parts[view.index] !== 'chaser' && parts[view.index] !== 'enemy') continue;
      const other = groups.current[view.index];
      if (other === null || other === undefined || !other.visible) continue;
      const gap = Math.hypot(other.position.x - me.position.x, other.position.z - me.position.z);
      if (gap < nearest) {
        nearest = gap;
        threat = view.index;
      }
    }
    const threatAt = threat < 0 ? null : groups.current[threat]!.position;
    const threatSize = threat < 0 ? null : drawn[threat]!;
    // Vzdálenost: aspoň `SEE_M` do strany, dál, dokud se hrdina a hrozba nevejdou, nejvýš tak, ať hrdina drží `HERO_SHARE` výšky.
    const hero = drawn[player]!;
    const heroR = Math.max(hero.w, hero.d) / 2;
    const tilt = fight ? FIGHT_TILT : STYLED_TILT;
    const most = (hero.h * tilt.cos + 2 * heroR * tilt.sin) / (2 * tan * (aspect < 1 ? HERO_SHARE_TALL : HERO_SHARE));
    const heroReach = (from: Vector3): number => reachOf(me.position.x - from.x, hero.h / 2, me.position.z - from.z, heroR, tan, aspect, HERO_EDGE, tilt);
    const threatReach = (at: Vector3, size: Size, from: Vector3): number => reachOf(at.x - from.x, size.h / 2, at.z - from.z, Math.max(size.w, size.d) / 2, tan, aspect, THREAT_EDGE, tilt);
    // Hrozba, která se s hrdinou pod strop `most` nevejde, pohled netáhne – ukáže ji šipka na okraji.
    let framed = false;
    if (threatAt !== null && threatSize !== null && nearest < THREAT_M) {
      mid.set((goal.x + threatAt.x) / 2, 0, (goal.z + threatAt.z) / 2);
      framed = Math.max(heroReach(mid), threatReach(threatAt, threatSize, mid)) <= most;
      if (framed) goal.copy(mid);
    }
    const snap = follow.current === null || restarted;
    const k = snap ? 1 : 1 - Math.exp(-delta * FOLLOW);
    aim.lerp(goal, k);
    const need = Math.max(heroReach(aim), framed ? threatReach(threatAt!, threatSize!, aim) : 0);
    const least = Math.max(16, (aspect < 1 ? SEE_M_TALL : SEE_M) / (tan * Math.min(1, aspect)));
    const wanted = Math.min(most, Math.max(least, need));
    const distance = snap ? wanted : follow.current!.distance + (wanted - follow.current!.distance) * k;
    follow.current = { tick, distance };
    camera.position.set(aim.x, distance * tilt.sin, aim.z - distance * tilt.cos);
    camera.lookAt(aim);
    applyIntro(camera, aim, introLeft(introClock()));
    // Otřes po zásahu souboje; zásah hráče ve hře člověka třese sběrnice efektů sama.
    if (watch !== null) shakeCamera(camera.position, watch.shake(now, session.humanRun()), now);
    camera.updateMatrixWorld();
    if (surface.current !== null) surface.current.dataset.playerX = projected.copy(me.position).project(camera).x.toFixed(3);
    pointEdge(threatAt === null ? null : mid.set(threatAt.x, threatAt.y + threatSize!.h / 2, threatAt.z), camera);
  });

  return (
    <>
      <ArenaFloor look={scene} half={half / UNIT} seed={session.world.seed} keep={keep} hero={heroHeight} />
      {views.map((view) => {
        if (view.role === ROLE.target) return null; // Cíl úkolu kreslí vrstva cílů (`TargetsMount`), ne kvádr.
        const part = parts[view.index]!;
        const size = drawn[view.index]!;
        const register = (group: Group | null): void => {
          groups.current[view.index] = group;
        };
        if (part === 'block') {
          // Věc pravidel nebo plot: kvádr jako v agaru.
          const thing = thingOf(view.kind);
          const namedModel = thing === null ? undefined : cast.things?.[thing];
          return (
            <group key={view.index} ref={register} userData={{ frame: thing === null ? undefined : 'target' }}>
              {namedModel !== undefined ? <FittedModel id={namedModel} w={view.w} h={view.h} d={view.d} fallback={thingColor(thing!)} character={view.h >= Math.max(view.w, view.d)} /> : <mesh position={[0, view.h / 2, 0]}>
                <boxGeometry args={[view.w, view.h, view.d]} />
                <meshStandardMaterial color={thing === null ? FENCE_COLOR : thingColor(thing)} roughness={0.6} />
              </mesh>}
            </group>
          );
        }
        const model = modelOf(part, cast);
        const spark = part === 'item' && view.kind === SPARK_KIND;
        const character = rigged[view.index];
        const fighter = startHp[view.index]! > 0;
        // Klip, který postava opravdu hraje: hrdina pro sondu `data-anim-clip`, soupeř souboje pro `data-rival-clip`.
        const onClip =
          part === 'hero'
            ? (clip: string) => { if (surface.current !== null) surface.current.dataset.animClip = clip; }
            : fighter
              ? (clip: string) => { if (surface.current !== null) surface.current.dataset.rivalClip = clip; }
              : undefined;
        return (
          // `frame` a `item` čte sonda záběru (`__playFrame`): hrdina, cíle a hrozby, pronásledovatel pod vlastním jménem.
          // Jiskra tepu nekreslí věc z věty, takže ani nenese její jméno (`item`).
          <group key={view.index} ref={register} userData={{ frame: part === 'hero' ? 'hero' : 'target', item: part === 'hero' || spark ? undefined : part === 'item' ? 'coin' : part }}>
            <group ref={(group) => { turned.current[view.index] = group; }}>
              {part === 'item' ? (
                spark ? <Spark size={size.h} /> : model === undefined ? <Gem size={size.h} /> : <FittedModel id={model} w={size.w} h={size.h} d={size.d} fallback={FALLBACK.item} />
              ) : (
                // Nápřah a pád bojovníka (`drawFighter`); výpad, úder a zásah hraje hračková póza vnitřní skupiny.
                <group ref={(group) => { leans.current[view.index] = group; }}>
                  {/* Obrys (P36C T6) jen na modelu – kruh, ukazatel zdraví a výstraha jsou mimo tuhle skupinu. */}
                  <InkOutline ink={part === 'hero' ? 'hero' : 'foe'} />
                  {/* Činnost hrdiny (P37B T2): soupeři a `none` dostanou model beze změny stromu. */}
                  <HeroActionBody action={part === 'hero' ? heroAction : 'none'} session={session} h={size.h}>
                    {character !== undefined ? (
                      <RiggedModel
                        character={character}
                        h={size.h}
                        clip={() => clips.current[view.index] ?? 'idle'}
                        fallback={FALLBACK[part]}
                        onClip={onClip}
                        toy={() => toyFrames.current[view.index] ?? { view: { ...toyViewOf(session.state(), session.prev(), view.index), attack: false }, tick: toyTickOf(session) }}
                      />
                    ) : (
                      <group ref={(group) => { posed.current[view.index] = group; }}>
                        <FittedModel id={model ?? ''} w={size.w} h={size.h} d={size.d} fallback={FALLBACK[part]} character={size.h >= Math.max(size.w, size.d)} posed />
                      </group>
                    )}
                  </HeroActionBody>
                </group>
              )}
              {fighter && part === 'hero' && <SwingArc register={(mesh) => { arc.current = mesh; }} />}
            </group>
            {part === 'item' && (
              // Zářící kruh na zemi pod věcí: svítí nad prahem bloomu, ať je věc vidět i z dálky.
              <mesh position={[0, 0.02 - ITEM_HOVER_M, 0]} rotation={[-Math.PI / 2, 0, 0]} userData={{ glow: true, rigShadow: 'receive' }}>
                <ringGeometry args={[size.w * 0.45, size.w * 0.6, 24]} />
                <meshBasicMaterial color={spark ? SPARK_GLOW : RING_GLOW} toneMapped={false} />
              </mesh>
            )}
            {part === 'hero' && (
              <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} userData={{ rigShadow: 'receive' }}>
                <ringGeometry args={[size.w / 2, size.w / 2 + 0.1, 32]} />
                <meshBasicMaterial color={brand.paper} />
              </mesh>
            )}
            {fighter && <HealthBar max={startHp[view.index]!} hero={part === 'hero'} h={size.h} register={(bar) => { bars.current[view.index] = bar; }} />}
            {(part === 'chaser' || part === 'enemy') && <Alert at={size.h + (fighter ? ALERT_ABOVE_BAR_M : 0.35)} register={(group) => { alerts.current[view.index] = group; }} />}
          </group>
        );
      })}
      <TargetsMount session={session} views={views} layer={targets ?? questTargets(session.world, { session, look: scene, heroAction }, cast.props?.target)} />
      {/* Slot ducha (P37-0 T3) – i pro úkol: stanoviště hrdinu nekreslí, druhý slot by ducha zdvojil. */}
      <GhostSlot ghost={ghost} session={session} />
    </>
  );
}

const DRAG_PX = 12;

/** Šipky/WASD (i dvě naráz = šikmo) a tah prstem = směr; puštěno = stát. */
export function useArenaInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const keys = new Set<string>();
    let drag: { readonly x: number; readonly y: number; dx: number; dz: number } | null = null;
    const sync = (): void => {
      const dx = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
      const dz = (keys.has('up') ? 1 : 0) - (keys.has('down') ? 1 : 0);
      if (dx !== 0 || dz !== 0) session.hold(arenaAxis(dx, dz));
      else session.hold(drag === null ? 0 : arenaAxis(drag.dx, drag.dz));
    };
    const keyOf = (key: string): string | null =>
      key === 'arrowleft' || key === 'a' ? 'left'
      : key === 'arrowright' || key === 'd' ? 'right'
      : key === 'arrowup' || key === 'w' ? 'up'
      : key === 'arrowdown' || key === 's' ? 'down'
      : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      // Akce pravidel (P29A T6): mezerník = „action“, `e` = „alt“; F/J/Enter patří střelbě doplňku.
      const button = event.key === ' ' ? BUTTON.TAP : event.key.toLowerCase() === 'e' ? BUTTON.FIRE : 0;
      if (button !== 0) {
        event.preventDefault();
        if (!event.repeat) session.press(button);
        return;
      }
      const key = keyOf(event.key.toLowerCase());
      if (key === null) return;
      event.preventDefault();
      keys.add(key);
      sync();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = keyOf(event.key.toLowerCase());
      if (key === null) return;
      keys.delete(key);
      sync();
    };
    const onDown = (event: PointerEvent) => {
      // Tah, který vyjede z plátna, se musí pustit i venku – jinak hráč jede dál.
      element.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, dx: 0, dz: 0 };
      sync();
    };
    const onMove = (event: PointerEvent) => {
      if (drag === null) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      // Obrazovka dolů = −z jádra.
      drag.dx = Math.round(dx);
      drag.dz = Math.round(-dy);
      sync();
    };
    const onUp = () => {
      // Ťuk bez tahu = akce.
      if (drag !== null && drag.dx === 0 && drag.dz === 0) session.press(BUTTON.TAP);
      drag = null;
      sync();
    };
    const release = (): void => {
      keys.clear();
      drag = null;
      sync();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', release);
    };
  }, [session, target, active]);
}
