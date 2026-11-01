'use client';

/**
 * Scéna střelnice z očí (P68-F T5, kategorie `prvni-osoba`). Hráč stojí v počátku a kouká přes vějíř 9 sektorů:
 * podlaha vějíře (dlažba interiéru sady, kovové plechy ve vesmíru, jinak povrch cesty sady), čáry hran sektorů,
 * oblouk dosahu (kdo ho překročí, vezme život) a nízké zábrany za místem nástupu; kolem zem sady, kulisy sady
 * a panorama místa z věty (T9, bez něj siluety obzoru). Nepřátelé z věty jdou po
 * paprscích svých sektorů k hráči (riggovaná postava nebo model z popisku), boss posledního kola je větší, terče
 * z role terče stojí na tyčích v řádcích výšky (`HEIGHT_ROWS`, y těla z jádra).
 *
 * **Kamera** jen sleduje `yawStep` ze stavu (`railfps-camera.ts`): póza z natočení předchozího a tohoto tiku
 * a podílu tiku kresby, na výšku i na šířku vlastní pole, horizont oka uprostřed `playRect`. Hra kameru nečte.
 * Natočení a pole, které scéna opravdu nakreslila, zapíše do `data-railfps-yaw` a `data-railfps-fov` plochy hry –
 * podle nich dotykový adaptér (`RailfpsTouch.tsx`) a e2e přepočítají bod na obrazovce na sektor. Z téže pózy kreslí
 * šipky hrozeb mimo záběr (`ThreatArrows.tsx`, T9).
 *
 * Zaměřovač je prstenec uprostřed záběru (vždy střed natočení), značka sektoru je slunečný klín na podlaze v cílovém
 * sektoru míření – ukáže, kam se kamera točí a kam padne rána. Nic z toho se nehýbe samo. Nepřítel roste do čitelnosti
 * podle vzdálenosti (`foeScale`, nejvýš `LEGIBLE_CAP`); terče ne – zvětšený terč by zakryl sousední řádek výšky.
 *
 * **Odezva zásahu** (T8, `RailfpsFeedback.tsx`): záblesk, paprsek, značka zásahu, rozpad terče, minutí a po ztrátě
 * života otřes a rajčatový okraj. Otřes je posun záběru v px, který scéna přičte až po své póze kamery; s
 * `prefers-reduced-motion` je nulový.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { type ReactNode, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { type Group, type InstancedMesh, Matrix4, type Mesh, type PerspectiveCamera, RingGeometry } from 'three';

import { color } from '@/brand/tokens';
import { baseControlOf } from '@/play/arcade/addons';
import { BODY, FLAG, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { type InteriorFloor, type Look, SURFACES } from '@/play/arcade/look';
import { foeScale, riggedCharacter } from '@/play/arcade/models';
import { RAILFPS, YAW, aimOf, foesOf, isEnemy, sameKind, yawStepOf } from '@/play/arcade/pieces/railfps-world';

import { renderHeld } from '../../effects/render-feel';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { interiorFloorMap } from '../../look/interior-floor';
import { Panorama } from '../../look/Panorama';
import { PlayEnv, type PlayEnvValue } from '../../look/play-env';
import { Scenery } from '../../look/Scenery';
import { playRect, usePlayRectRef } from '../../portrait-frame';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps } from '../../World';
import { HUD_BAND_PX, THUMB_ZONE_PX } from '../portrait-first';
import { type FeedbackShake, NO_SHAKE, RailfpsFeedback } from './RailfpsFeedback';
import { RAILFPS_LAYOUT, applyPose, cameraPose, heightShare, scenePoint } from './railfps-camera';
import { offscreenThreats, useThreatArrows } from './ThreatArrows';

const m = (units: number): number => units / UNIT;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Půl vějíře (°): krajní sektor ±4 sahá do 67,5°. */
const FAN = (YAW.maxSector + 0.5) * YAW.stepDeg;
/** Zábrany stojí za místem nástupu nepřátel, podlaha vějíře sahá kousek za ně (m). */
const BARRIER_R = RAILFPS_LAYOUT.barrier;
const DECK_R = BARRIER_R + 1;
/** Kam sahá zem sady kolem vějíře (m); stálý objekt pro `FieldGround`. */
const GROUND_AREA = { x0: -60, x1: 60, z0: -20, z1: 70 };
/** Postavy, jak je scéna kreslí (m). */
const FOE = { w: m(RAILFPS.enemy.w), h: m(RAILFPS.enemy.h), d: m(RAILFPS.enemy.d) } as const;
const BIG = { w: m(RAILFPS.boss.w), h: m(RAILFPS.boss.h), d: m(RAILFPS.boss.d) } as const;
const MARK = { w: m(RAILFPS.target.w), h: m(RAILFPS.target.h) } as const;
/**
 * Zásoby skupin: nepřátel ve vlně je nejvýš `enemyPct` % z `waveMax` (tak je počítá `railfpsWave`, boss má vlastní
 * skupinu), terčů nejvýš celá vlna – víc živých kolo nemá, kolo končí až po posledním.
 */
const POOL = { foes: Math.ceil((RAILFPS.waveMax * RAILFPS.enemyPct) / 100), marks: RAILFPS.waveMax } as const;
/** Zaměřovač: poloměr na obrazovce (px) a vzdálenost před okem, kde se kreslí (m). */
const CROSSHAIR = { px: RAILFPS_LAYOUT.crosshairPx, at: 1 } as const;
/** Skok dál než tohle (m) mezi tiky je nové tělo, ne chůze – neinterpoluje se. */
const JUMP = 2.5;
/** Výchozí nepřítel, když popisek model nemá (jako přežití). */
const DEFAULT_FOE = 'rigged:q-big-orc';

type RailfpsSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

/** Postava z popisku: riggovaná, nebo model vepsaný do kvádru. */
function Figure({ model, size, tint, moving }: { readonly model: string; readonly size: { readonly w: number; readonly h: number; readonly d: number }; readonly tint: string; readonly moving: () => boolean }) {
  const rig = riggedCharacter(model);
  return rig !== undefined ? (
    <RiggedModel character={rig} h={size.h} clip={() => (moving() ? 'run' : 'idle')} fallback={tint} />
  ) : (
    <FittedModel id={model} w={size.w} h={size.h} d={size.d} fallback={tint} character />
  );
}

/** Plochý klín podlahy od `r0` do `r1` přes `half`° na obě strany osy +z skupiny. */
function Wedge({ r0, r1, half, y, tint, opacity = 1 }: { readonly r0: number; readonly r1: number; readonly half: number; readonly y: number; readonly tint: string; readonly opacity?: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} receiveShadow={opacity === 1}>
      {/* Úhel prstence θ leží po rotaci ve směru (cos θ, 0, −sin θ): θ = −π/2 je +z. */}
      <ringGeometry args={[r0, r1, Math.max(4, Math.round(half / 3)), 1, -Math.PI / 2 - rad(half), 2 * rad(half)]} />
      {opacity === 1 ? <meshStandardMaterial color={tint} roughness={0.9} /> : <meshBasicMaterial color={tint} transparent opacity={opacity} depthWrite={false} />}
    </mesh>
  );
}

const REACH_M = m(RAILFPS.reach);
/**
 * Kus natočený tak, aby jeho +z mířilo na úhel `deg` (kladný doprava = −x scény), posunutý po té ose do výšky `y`
 * a vzdálenosti `z` a sklopený o `tilt` kolem x.
 */
const placed = (deg: number, y: number, z: number, tilt = 0): Matrix4 =>
  new Matrix4().makeRotationY(-rad(deg)).multiply(new Matrix4().makeTranslation(0, y, z)).multiply(new Matrix4().makeRotationX(tilt));
/** Hrany sektorů na podlaze (od dosahu po zábrany) a zábrany za místem nástupu, každý druh jedna instancovaná síť (T9). */
const EDGE_MATRICES = Array.from({ length: YAW.maxSector }, (_, k) => (k + 0.5) * YAW.stepDeg)
  .flatMap((deg) => [deg, -deg])
  .map((deg) => placed(deg, 0.005, (REACH_M + BARRIER_R) / 2, -Math.PI / 2));
const BARRIER_MATRICES = Array.from({ length: YAW.sectors }, (_, index) => placed((index - YAW.maxSector) * YAW.stepDeg, 0.5, BARRIER_R));

/** Jedna instancovaná síť z geometrie a materiálu v `children`, kus v každé matici (stojí, matice se píšou jednou). */
function Instances({ matrices, receiveShadow = false, children }: { readonly matrices: readonly Matrix4[]; readonly receiveShadow?: boolean; readonly children: ReactNode }) {
  const mesh = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const made = mesh.current;
    if (made === null) return;
    matrices.forEach((matrix, i) => made.setMatrixAt(i, matrix));
    made.instanceMatrix.needsUpdate = true;
    made.computeBoundingSphere();
  }, [matrices]);
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, matrices.length]} receiveShadow={receiveShadow}>
      {children}
    </instancedMesh>
  );
}

/**
 * Podlaha vějíře (T9): interiér sady klade svou dlažbu, vesmírné místo (panorama se štítkem `space`: stanice, loď,
 * měsíc) kovové plechy interiéru továrny; jinak povrch cesty sady bez textury (`null`). Hnědá hlína sady `space`
 * je regolit závodní dráhy – „space station hallway“ na ní nevypadala jako stanice.
 */
const deckFloor = (look: Look, env: PlayEnvValue | null): InteriorFloor | null => look.interior?.floor ?? (env?.tags.includes('space') === true ? 'metal' : null);

/** Podlaha vějíře: klín od oka do `DECK_R` přes celý vějíř, dlažba s UV v metrech (`interiorFloorMap`), nebo barva povrchu. */
function Deck({ look, floor }: { readonly look: Look; readonly floor: InteriorFloor | null }) {
  const geometry = useMemo(() => {
    const ring = new RingGeometry(0, DECK_R, Math.round(FAN / 3), 8, -Math.PI / 2 - rad(FAN), 2 * rad(FAN));
    // UV v metrech (x, y kruhu před položením), jak je čte textura dlažby interiéru.
    const position = ring.getAttribute('position');
    const uv = ring.getAttribute('uv');
    for (let i = 0; i < position.count; i += 1) uv.setXY(i, position.getX(i), position.getY(i));
    return ring;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
      {floor === null ? <meshStandardMaterial color={SURFACES[look.surface].color} roughness={0.9} /> : <meshStandardMaterial map={interiorFloorMap(floor)} roughness={0.85} />}
    </mesh>
  );
}

export function RailfpsScene({ session, cast, surface, scene: look }: RailfpsSceneProps) {
  const world = session.world;
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const size = useThree((three) => three.size);
  const measured = usePlayRectRef();
  const { keeper, boss: bossTemplate } = useMemo(() => baseControlOf(world.control).params as { readonly keeper: number; readonly boss: number }, [world]);
  const foeModel = cast.enemy === '' ? DEFAULT_FOE : cast.enemy;
  const bossModel = cast.boss?.model ?? cast.things?.boss ?? foeModel;
  const markModel = cast.props.target ?? cast.things?.target ?? 'target';
  const barrierTint = look.block?.[1] ?? look.tint[0];
  // Místo z věty (T9): panorama prostředí (`PlayEnv` z obalu hry) je pozadí chodby. Panorama jen pro tohle místo
  // (`look: null` v katalogu – stanice, pirátská loď) nahradí i obecné kulisy sady: rakety a lunární moduly sady
  // `space` by stály uprostřed můstku stanice.
  const env = useContext(PlayEnv);
  const ownPlace = env !== null && env.look === null;
  const floor = deckFloor(look, env);
  const threats = useThreatArrows(surface);

  const foes = useRef<(Group | null)[]>([]);
  const boss = useRef<Group | null>(null);
  const marks = useRef<(Group | null)[]>([]);
  const posts = useRef<(Mesh | null)[]>([]);
  const goal = useRef<Group | null>(null);
  const crosshair = useRef<Group | null>(null);
  const memory = useRef({ foeMoving: [] as boolean[], bossMoving: false });
  const kick = useRef<FeedbackShake>(NO_SHAKE);

  // Vlastní pole a posun záběru jen pro tuhle scénu; po odchodu se vrátí.
  useEffect(() => {
    const fov = camera.fov;
    return () => {
      camera.fov = fov;
      camera.clearViewOffset();
      camera.updateProjectionMatrix();
    };
  }, [camera]);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const running = state[HEADER.runState] === 0;

    // Kamera: póza z natočení stavu, nikdy obráceně. Pás hry z DOM, než se změří, z tokenů kitu.
    const rect = measured.current ?? playRect(size, HUD_BAND_PX, size.height - THUMB_ZONE_PX);
    const pose = cameraPose(yawStepOf(prev, keeper), yawStepOf(state, keeper), alpha, camera.aspect, rect);
    applyPose(camera, pose, size.width, size.height);
    // Šipky hrozeb mimo záběr (T9) z pózy, kterou tenhle snímek kreslí.
    threats.current?.paint(running ? offscreenThreats(state, pose.yawDeg, camera.aspect, pose.fovDeg) : [], rect);
    // Otřes po ztrátě života (`RailfpsFeedback`): posun záběru v px nad pózou, mimo stav i data pro dotyk.
    const shake = kick.current;
    if (shake.x !== 0 || shake.y !== 0) {
      camera.setViewOffset(size.width, size.height, shake.x, pose.shift + shake.y, size.width, size.height);
      camera.updateProjectionMatrix();
    }
    const host = surface.current;
    if (host !== null) {
      const yaw = pose.yawDeg.toFixed(2);
      const fov = pose.fovDeg.toFixed(2);
      if (host.dataset.railfpsYaw !== yaw) host.dataset.railfpsYaw = yaw;
      if (host.dataset.railfpsFov !== fov) host.dataset.railfpsFov = fov;
    }

    // Zaměřovač: prstenec před okem ve směru natočení, velikost v px nezávislá na poli.
    if (crosshair.current !== null) {
      const yaw = rad(pose.yawDeg);
      crosshair.current.position.set(-Math.sin(yaw) * CROSSHAIR.at, pose.position.y, Math.cos(yaw) * CROSSHAIR.at);
      crosshair.current.quaternion.copy(camera.quaternion);
      crosshair.current.scale.setScalar((2 * CROSSHAIR.px * CROSSHAIR.at * Math.tan(rad(pose.fovDeg) / 2)) / Math.max(1, size.height));
    }
    // Značka sektoru: klín v cílovém sektoru míření (cíl je vždy celý sektor, `sectorToStep`).
    if (goal.current !== null) goal.current.rotation.y = -rad((aimOf(state, keeper).goal / YAW.stepsPerSector) * YAW.stepDeg);

    /** Poloha těla ve scéně (m), interpolovaná; nové tělo se neinterpoluje. */
    const place = (body: number): { x: number; y: number; z: number } => {
      const base = bodyBase(body);
      const now = scenePoint(state[base + BODY.x] as number, state[base + BODY.y] as number, state[base + BODY.z] as number);
      const was = scenePoint(prev[base + BODY.x] as number, prev[base + BODY.y] as number, prev[base + BODY.z] as number);
      const fresh = ((prev[base + BODY.flags] as number) & FLAG.alive) === 0 || Math.abs(now.x - was.x) + Math.abs(now.z - was.z) > JUMP;
      return fresh ? now : { x: was.x + (now.x - was.x) * alpha, y: was.y + (now.y - was.y) * alpha, z: was.z + (now.z - was.z) * alpha };
    };
    const moving = (body: number): boolean => running && (state[bodyBase(body) + BODY.z] !== prev[bodyBase(body) + BODY.z] || state[bodyBase(body) + BODY.x] !== prev[bodyBase(body) + BODY.x]);
    /** Postava čelem k hráči a zvětšená do čitelnosti podle vzdálenosti od oka (spojitě – cestou jen roste). */
    const stand = (group: Group, body: number, height: number): void => {
      const at = place(body);
      group.position.set(at.x, 0, at.z);
      group.rotation.y = Math.atan2(-at.x, -at.z);
      group.scale.setScalar(foeScale(heightShare(height, Math.hypot(at.x, at.z), pose.fovDeg)));
    };

    const live = foesOf(state);
    const enemies = live.filter((body) => isEnemy(state, body) && !sameKind(state, body, bossTemplate));
    const big = live.find((body) => isEnemy(state, body) && sameKind(state, body, bossTemplate));
    const targets = live.filter((body) => !isEnemy(state, body));

    for (let slot = 0; slot < POOL.foes; slot += 1) {
      const group = foes.current[slot];
      if (group == null) continue;
      const body = enemies[slot];
      group.visible = body !== undefined;
      if (body === undefined) continue;
      stand(group, body, FOE.h);
      memory.current.foeMoving[slot] = moving(body);
    }
    if (boss.current !== null) {
      boss.current.visible = big !== undefined;
      if (big !== undefined) {
        stand(boss.current, big, BIG.h);
        memory.current.bossMoving = moving(big);
      }
    }
    for (let slot = 0; slot < POOL.marks; slot += 1) {
      const group = marks.current[slot];
      if (group == null) continue;
      const body = targets[slot];
      group.visible = body !== undefined;
      if (body === undefined) continue;
      // y terče je jeho spodní hrana v řádku výšky; tyč drží terč od země.
      const at = place(body);
      group.position.set(at.x, at.y, at.z);
      group.rotation.y = Math.atan2(-at.x, -at.z);
      const post = posts.current[slot];
      if (post != null) {
        post.scale.y = Math.max(0.01, at.y);
        post.position.y = -at.y / 2;
      }
    }
  });

  const reach = REACH_M;

  return (
    <>
      {/* Podlaha vějíře (dlažba interiéru nebo povrch cesty sady), kolem zem sady – pod panoramatem místa, když je. */}
      <Deck look={look} floor={floor} />
      <FieldGround look={look} area={GROUND_AREA} y={-0.06} under={env !== null} />
      {/* Hrany sektorů (jedna instancovaná síť) a oblouk dosahu: kdo ho překročí, vezme život. */}
      <Instances matrices={EDGE_MATRICES}>
        <planeGeometry args={[0.06, BARRIER_R - reach]} />
        <meshBasicMaterial color={color.ink} transparent opacity={0.28} depthWrite={false} />
      </Instances>
      <Wedge r0={reach - 0.06} r1={reach + 0.06} half={FAN} y={0.01} tint={color.ink} opacity={0.6} />
      <group ref={goal}>
        <Wedge r0={RAILFPS_LAYOUT.markNear} r1={BARRIER_R} half={YAW.stepDeg / 2} y={0.008} tint={color.sun} opacity={0.32} />
      </group>
      {/*
        Nízké zábrany za místem nástupu, přes které je vidět. Boční stěny podél krajních sektorů (T5) tu nejsou: stěna
        po paprsku od oka je z oka vidět jen hranou, a ta u oka (1,5 m) zabrala na výšku levých ~40 % obrazu (T9).
        Jedna instancovaná síť bez vrhání stínu: metrový kvádr 24 m daleko stín na obrazovce nemá.
      */}
      <Instances matrices={BARRIER_MATRICES} receiveShadow>
        <boxGeometry args={[2 * BARRIER_R * Math.sin(rad(YAW.stepDeg / 2)) * 0.9, 1, 0.6]} />
        <meshStandardMaterial color={barrierTint} roughness={0.85} />
      </Instances>
      {/*
        Kulisy sady po stranách a vpředu za zábranami (`behind` kreslí jen +x, skupina ho otočí dopředu) – ne pod
        panoramatem jen pro tohle místo. Pak obzor: panorama místa, bez něj siluety sady.
      */}
      {!ownPlace && (
        <>
          <Scenery look={look} layout="sides" inner={DECK_R + 3} from={-6} to={40} />
          <group rotation={[0, -Math.PI / 2, 0]}>
            <Scenery look={look} layout="behind" inner={DECK_R + 5} from={-36} to={36} />
          </group>
        </>
      )}
      {env === null ? (
        <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={DECK_R + 14} />
      ) : (
        <Suspense fallback={null}>
          <Panorama env={env} />
        </Suspense>
      )}

      {Array.from({ length: POOL.foes }, (_, slot) => (
        <group
          key={`foe-${String(slot)}`}
          ref={(group) => {
            foes.current[slot] = group;
          }}
          visible={false}
          userData={{ frame: 'target', item: 'enemy', foe: true }}
        >
          <Figure model={foeModel} size={FOE} tint={color.tomato} moving={() => memory.current.foeMoving[slot] === true} />
        </group>
      ))}
      <group ref={boss} visible={false} userData={{ frame: 'target', item: 'boss', foe: true }}>
        <Figure model={bossModel} size={BIG} tint={color['tomato-deep']} moving={() => memory.current.bossMoving} />
      </group>
      {Array.from({ length: POOL.marks }, (_, slot) => (
        <group
          key={`mark-${String(slot)}`}
          ref={(group) => {
            marks.current[slot] = group;
          }}
          visible={false}
          userData={{ frame: 'target', item: 'target' }}
        >
          <FittedModel id={markModel} w={MARK.w} h={MARK.h} d={MARK.w} fallback={color.sun} />
          <mesh
            ref={(mesh) => {
              posts.current[slot] = mesh;
            }}
          >
            <cylinderGeometry args={[0.05, 0.05, 1, 8]} />
            <meshStandardMaterial color={color.ink} roughness={0.7} />
          </mesh>
        </group>
      ))}

      {/* Zaměřovač: papírový prstenec s inkoustovým okrajem, vždy navrchu. */}
      <group ref={crosshair} renderOrder={20}>
        <mesh renderOrder={20}>
          <ringGeometry args={[0.55, 0.85, 32]} />
          <meshBasicMaterial color={color.paper} transparent depthTest={false} depthWrite={false} toneMapped={false} fog={false} />
        </mesh>
        <mesh renderOrder={20}>
          <ringGeometry args={[0.85, 1, 32]} />
          <meshBasicMaterial color={color.ink} transparent depthTest={false} depthWrite={false} toneMapped={false} fog={false} />
        </mesh>
      </group>
      <RailfpsFeedback session={session} keeper={keeper} surface={surface} kick={kick} />
    </>
  );
}
