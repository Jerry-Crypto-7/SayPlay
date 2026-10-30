'use client';

/**
 * Scéna přežití ve vlnách (P66 T5): aréna na výšku (vyšší než širší) v místě z věty – podlaha v barvě dráhy sady,
 * kolem ní povrch prostředí a kulisy sady. Hrdina z věty uprostřed záběru, nepřátelé z věty jdou od okrajů, boss
 * posledního kola je větší postava s ukazatelem HP; střely, krystaly s rámečkem vzácnosti a koule bosse.
 *
 * **Kamera** jede za hrdinou shora zezadu: na výšku telefonu (`aspect < 1`) se okno kolem hrdiny vepíše přes
 * `../portrait-first.ts` (`fitTall`) do pásu mezi horním HUD a zónou palce; na šířku vlastní póza se širším oknem.
 * Okno se drží uvnitř arény, takže u stěny je vidět okraj. Jen obraz, mimo stav i hash: varování útoku bosse (pás
 * rozběhu, kruh dupnutí, štítek), blikání hrdiny v milosti, poskakování krystalů.
 *
 * x jádra se zrcadlí jako v aréně: kamera kouká po +z, takže +x je na obrazovce vpravo a tah doprava jde doprava.
 * Nepřátelé, střely, krystaly a koule se kreslí ze zásob skupin (`POOL`) – strop sítí telefonu nezávisí na vlně.
 */

import { Html } from '@react-three/drei/web/Html';
import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Box3, Color, type Group, type Mesh, type MeshStandardMaterial, type PerspectiveCamera, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { baseControlOf } from '@/play/arcade/addons';
import { BODY, FLAG, HEADER, UNIT, bodyBase, bodyHp, graceOf } from '@/play/arcade/contract';
import { rarityOf } from '@/play/arcade/hooks';
import type { Rarity } from '@/play/arcade/hooks/contract';
import { SURFACES } from '@/play/arcade/look';
import { riggedCharacter } from '@/play/arcade/models';
import { DIRECTIONS } from '@/play/arcade/pieces/arena';
import { BOSS_PHASE, SURVIVOR, SURVIVOR_BODIES, type SurvivorAttack, bossAimOf, bossAttackIndexOf, bossOf, bossPhaseOf, copiesOf, enemiesOf, isBoss } from '@/play/arcade/pieces/survivor-world';

import { renderHeld } from '../../effects/render-feel';
import { worldPlacement } from '../../Ghost';
import { GhostSlot } from '../../GhostSlot';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { Scenery } from '../../look/Scenery';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps } from '../../World';
import { fitTall, tokenRect } from '../portrait-first';

const m = (units: number): number => units / UNIT;
/** Polovina arény (m). */
const AX = m(SURVIVOR.halfX);
const AZ = m(SURVIVOR.halfZ);
/** Postavy, jak je scéna kreslí (m): kolize jádra jsou kvádry, postava stojí na zemi. */
const HERO = { w: 0.9, h: 1.6, d: 0.8 } as const;
const FOE = { w: 1.0, h: 1.5, d: 0.9 } as const;
const BIG = { w: m(SURVIVOR.boss.w), h: m(SURVIVOR.boss.h), d: m(SURVIVOR.boss.d) } as const;
/** Kolik čeho scéna kreslí naráz (víc živých kolo nemá – strop krystalů, posil a salvy). */
const POOL = { foes: 12, shots: 8, crystals: SURVIVOR.crystals, orbs: 12 } as const;
/**
 * Okno kolem hrdiny (polovina šířky a hloubky, m): na výšku užší, ať je hrdina čitelný (`LEGIBLE_SHARE.hero`) a nepřítel
 * od okraje arény přijde zpoza okraje obrazu; na šířku celá šíře arény.
 */
const VIEW = { tall: { x: 3.4, z: 5.0 }, wide: { x: AX, z: 5.2 } } as const;
/** Náklon kamery a jak daleko za okraj arény smí okno sahat (m). */
const CAMERA = { elevation: (62 * Math.PI) / 180, overhang: 0.8, follow: 6 } as const;
/** Skok dál než tohle (m) mezi tiky je návrat nebo nové tělo, ne pohyb – neinterpoluje se. */
const JUMP = 2.5;
/** Výchozí nepřítel, když popisek model nemá. */
const DEFAULT_FOE = 'rigged:q-big-orc';
/** Barvy vzácnosti krystalu z kitu: běžná inkoust, vzácná modrozelená (mint + sky jako `play-hooks.css`), epická slunečná. */
const RARITY_TINT: Readonly<Record<Rarity, string>> = { common: color.ink, rare: `#${new Color(color.mint).lerp(new Color(color.sky), 0.5).getHexString()}`, epic: color.sun };
/** Štítek útoku bosse (≤ 12 znaků, `11-voice-copy.md`). */
const ATTACK_TAG: Readonly<Record<SurvivorAttack, string>> = { charge: 'Charge!', stomp: 'Stomp!', shoot: 'Incoming!' };

type SurvivorSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

/** Natočení postavy čelem po směru jádra (`dx`, `dz`): x scény je zrcadlené, model kouká po +z. */
const yawOf = (dx: number, dz: number): number => Math.atan2(-dx, dz);
const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

/** Postava z popisku: riggovaná, nebo model vepsaný do kvádru. */
function Figure({ model, size, tint, moving }: { readonly model: string; readonly size: { readonly w: number; readonly h: number; readonly d: number }; readonly tint: string; readonly moving?: () => boolean }) {
  const rig = riggedCharacter(model);
  return rig !== undefined ? (
    <RiggedModel character={rig} h={size.h} clip={() => (moving?.() === true ? 'run' : 'idle')} fallback={tint} />
  ) : (
    <FittedModel id={model} w={size.w} h={size.h} d={size.d} fallback={tint} character />
  );
}

/** Pás rozběhu a kruh dupnutí na zemi: rajčatové, poloprůhledné. */
function DangerMarks({ strip, ring }: { readonly strip: React.RefObject<Mesh | null>; readonly ring: React.RefObject<Mesh | null> }) {
  return (
    <>
      <mesh ref={strip} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} visible={false}>
        <planeGeometry args={[BIG.w, 8]} />
        <meshBasicMaterial color={color.tomato} transparent opacity={0.35} depthWrite={false} />
      </mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]} visible={false}>
        <ringGeometry args={[3.3, 3.6, 48]} />
        <meshBasicMaterial color={color.tomato} transparent opacity={0.6} depthWrite={false} />
      </mesh>
    </>
  );
}

export function SurvivorScene({ session, cast, surface, scene: look, ghost }: SurvivorSceneProps) {
  const world = session.world;
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const size = useThree((three) => three.size);
  const foeModel = cast.enemy === '' ? DEFAULT_FOE : cast.enemy;
  const bossModel = cast.boss?.model ?? cast.things?.boss ?? foeModel;
  const dropModel = cast.things?.drop ?? 'crystal';
  const ammoModel = cast.things?.ammunition;
  const attacks = useMemo((): readonly SurvivorAttack[] => (baseControlOf(world.control).params.attacks as readonly SurvivorAttack[] | undefined) ?? ['charge', 'shoot'], [world]);

  const hero = useRef<Group | null>(null);
  const foes = useRef<(Group | null)[]>([]);
  const boss = useRef<Group | null>(null);
  const bossHp = useRef<HTMLSpanElement | null>(null);
  const bossBar = useRef<HTMLSpanElement | null>(null);
  const bossTag = useRef<HTMLSpanElement | null>(null);
  const strip = useRef<Mesh | null>(null);
  const ring = useRef<Mesh | null>(null);
  const shots = useRef<(Group | null)[]>([]);
  const crystals = useRef<(Group | null)[]>([]);
  const frames = useRef<(MeshStandardMaterial | null)[]>([]);
  const orbs = useRef<(Mesh | null)[]>([]);
  const clock = useRef(0);
  const memory = useRef({ moving: false, foeMoving: [] as boolean[], view: null as { x: number; z: number } | null });
  const scratch = useMemo(() => ({ center: new Vector3(), back: new Vector3(), box: new Box3(), probe: new Vector3() }), []);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    clock.current += delta;
    const state = session.state();
    const prev = session.prev();
    const running = state[HEADER.runState] === 0;
    /** Poloha těla ve scéně (m), interpolovaná; skok (nové tělo, odhod) se neinterpoluje. */
    const place = (body: number): { x: number; z: number } => {
      const base = bodyBase(body);
      const nx = state[base + BODY.x] as number;
      const nz = state[base + BODY.z] as number;
      const px = prev[base + BODY.x] as number;
      const pz = prev[base + BODY.z] as number;
      const fresh = ((prev[base + BODY.flags] as number) & FLAG.alive) === 0 || Math.abs(m(nx - px)) + Math.abs(m(nz - pz)) > JUMP;
      return fresh ? { x: -m(nx), z: m(nz) } : { x: -m(px + (nx - px) * alpha), z: m(pz + (nz - pz) * alpha) };
    };
    const moving = (body: number): boolean => Math.abs(state[bodyBase(body) + BODY.vx] as number) + Math.abs(state[bodyBase(body) + BODY.vz] as number) > 10;

    // Hrdina: čelem po směru pohybu; v milosti po zásahu bliká.
    const player = state[HEADER.player] as number;
    const heroAt = place(player);
    const facing = DIRECTIONS[(state[bodyBase(player) + BODY.aux0] as number) & 31] as { dx: number; dz: number };
    memory.current.moving = moving(player);
    if (hero.current !== null) {
      hero.current.position.set(heroAt.x, 0, heroAt.z);
      hero.current.rotation.y = yawOf(facing.dx, facing.dz);
      hero.current.visible = graceOf(state, player) === 0 || Math.floor(clock.current * 12) % 2 === 0;
    }

    // Nepřátelé (bez bosse) ze zásoby, čelem k hrdinovi.
    const live = enemiesOf(state);
    const regulars = live.filter((i) => !isBoss(state, i));
    for (let slot = 0; slot < POOL.foes; slot += 1) {
      const group = foes.current[slot];
      if (group == null) continue;
      const body = regulars[slot];
      group.visible = body !== undefined;
      if (body === undefined) continue;
      const at = place(body);
      group.position.set(at.x, 0, at.z);
      group.rotation.y = Math.atan2(heroAt.x - at.x, heroAt.z - at.z);
      memory.current.foeMoving[slot] = moving(body);
    }

    // Boss: ukazatel HP, varování útoku (pás rozběhu, kruh dupnutí, štítek) v telegrafu.
    const big = bossOf(state);
    if (boss.current !== null) boss.current.visible = big >= 0;
    // `Html` je DOM: neviditelná skupina ho neschová, bez bosse by ukazatel visel uprostřed arény.
    if (bossHp.current !== null) bossHp.current.style.visibility = big >= 0 ? 'visible' : 'hidden';
    if (strip.current !== null) strip.current.visible = false;
    if (ring.current !== null) ring.current.visible = false;
    if (big >= 0 && boss.current !== null) {
      const at = place(big);
      boss.current.position.set(at.x, 0, at.z);
      boss.current.rotation.y = Math.atan2(heroAt.x - at.x, heroAt.z - at.z);
      const full = Math.max(1, bodyHp(state, SURVIVOR_BODIES.boss));
      if (bossBar.current !== null) bossBar.current.style.width = `${Math.round((100 * bodyHp(state, big)) / full)}%`;
      const phase = bossPhaseOf(state, big);
      const attack = attacks[bossAttackIndexOf(state, big)] ?? 'charge';
      const warn = running && phase === BOSS_PHASE.telegraph;
      if (bossTag.current !== null) {
        if (bossTag.current.textContent !== ATTACK_TAG[attack]) bossTag.current.textContent = ATTACK_TAG[attack];
        bossTag.current.style.visibility = warn ? 'visible' : 'hidden';
      }
      const pulse = 0.3 + 0.2 * Math.abs(Math.sin(clock.current * 10));
      if (warn && attack === 'charge' && strip.current !== null) {
        const aim = DIRECTIONS[bossAimOf(state, big)] as { dx: number; dz: number };
        const sx = -aim.dx / 1000;
        const sz = aim.dz / 1000;
        strip.current.visible = true;
        strip.current.position.set(at.x + sx * 4, 0.03, at.z + sz * 4);
        strip.current.rotation.set(-Math.PI / 2, 0, Math.atan2(sx, sz));
        (strip.current.material as { opacity: number }).opacity = pulse;
      }
      if (warn && attack === 'stomp' && ring.current !== null) {
        ring.current.visible = true;
        ring.current.position.set(at.x, 0.035, at.z);
      }
    } else if (bossTag.current !== null) bossTag.current.style.visibility = 'hidden';

    // Střely, krystaly (s rámečkem vzácnosti, poskakují) a koule bosse.
    const fly = copiesOf(state, SURVIVOR_BODIES.shot);
    shots.current.forEach((group, slot) => {
      if (group == null) return;
      const body = fly[slot];
      group.visible = body !== undefined;
      if (body !== undefined) {
        const at = place(body);
        group.position.set(at.x, m(SURVIVOR.shot.y), at.z);
      }
    });
    const gems = copiesOf(state, SURVIVOR_BODIES.crystal);
    crystals.current.forEach((group, slot) => {
      if (group == null) return;
      const body = gems[slot];
      group.visible = body !== undefined;
      if (body === undefined) return;
      const at = place(body);
      group.position.set(at.x, 0.15 + 0.12 * Math.sin(clock.current * 4 + slot), at.z);
      group.rotation.y = clock.current * 1.5 + slot;
      frames.current[slot]?.color.set(RARITY_TINT[rarityOf(state, body) ?? 'common']);
    });
    const balls = copiesOf(state, SURVIVOR_BODIES.orb);
    orbs.current.forEach((mesh, slot) => {
      if (mesh == null) return;
      const body = balls[slot];
      mesh.visible = body !== undefined;
      if (body !== undefined) {
        const at = place(body);
        mesh.position.set(at.x, m(SURVIVOR.orb.y + SURVIVOR.orb.h / 2), at.z);
      }
    });

    // Kamera za hrdinou: okno kolem něj, uvnitř arény; na výšku vepsané do pásu hry (`fitTall`).
    const tall = camera.aspect < 1;
    const view = tall ? VIEW.tall : VIEW.wide;
    const want = { x: clamp(heroAt.x, Math.max(0, AX + CAMERA.overhang - view.x)), z: clamp(heroAt.z, Math.max(0, AZ + CAMERA.overhang - view.z)) };
    const last = memory.current.view ?? want;
    const ease = 1 - Math.exp(-CAMERA.follow * Math.min(delta, 0.1));
    const center = { x: last.x + (want.x - last.x) * ease, z: last.z + (want.z - last.z) * ease };
    memory.current.view = center;
    scratch.center.set(center.x, 0.6, center.z);
    scratch.back.set(0, Math.sin(CAMERA.elevation), -Math.cos(CAMERA.elevation));
    camera.position.copy(scratch.center).addScaledVector(scratch.back, 20);
    camera.lookAt(scratch.center);
    camera.updateMatrixWorld();
    scratch.box.min.set(center.x - view.x, 0, center.z - view.z);
    scratch.box.max.set(center.x + view.x, HERO.h, center.z + view.z);
    if (tall) {
      const fit = fitTall(camera, scratch.box, tokenRect(size.width, size.height));
      camera.position.copy(scratch.center).addScaledVector(scratch.back, fit.distance);
      camera.setViewOffset(size.width, size.height, 0, fit.shift, size.width, size.height);
    } else {
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const distance = Math.max((view.z * Math.sin(CAMERA.elevation) + HERO.h) / tan, view.x / (tan * camera.aspect));
      camera.position.copy(scratch.center).addScaledVector(scratch.back, distance);
      if (camera.view !== null) camera.clearViewOffset();
    }
    camera.lookAt(scratch.center);
    camera.updateMatrixWorld();
    const host = surface.current;
    if (host !== null) host.dataset.playerX = scratch.probe.set(heroAt.x, HERO.h, heroAt.z).project(camera).x.toFixed(3);
  });

  return (
    <>
      {/* Hrací plocha v povrchu cesty sady (jako šipky; tmavá barva dráhy dělala z arény černou plochu, nepřátelé
          v ní zanikali), kolem povrch prostředí a kulisy sady ze všech čtyř stran. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[2 * AX, 2 * AZ]} />
        <meshStandardMaterial color={SURFACES[look.surface].color} roughness={0.9} />
      </mesh>
      {[-1, 1].map((side) => (
        <group key={`rim-${String(side)}`}>
          <mesh position={[side * (AX + 0.12), 0.06, 0]}>
            <boxGeometry args={[0.24, 0.12, 2 * AZ + 0.48]} />
            <meshStandardMaterial color={color.ink} roughness={0.7} />
          </mesh>
          <mesh position={[0, 0.06, side * (AZ + 0.12)]}>
            <boxGeometry args={[2 * AX + 0.48, 0.12, 0.24]} />
            <meshStandardMaterial color={color.ink} roughness={0.7} />
          </mesh>
        </group>
      ))}
      <FieldGround look={look} area={{ x0: -AX - 30, x1: AX + 30, z0: -AZ - 30, z1: AZ + 40 }} y={-0.06} />
      <group>
        <Scenery look={look} layout="sides" inner={AX + 1.6} from={-AZ} to={AZ} />
      </group>
      <group rotation={[0, Math.PI / 2, 0]}>
        <Scenery look={look} layout="sides" inner={AZ + 1.6} from={-AX} to={AX} />
      </group>
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={20} />
      <group ref={hero} userData={{ frame: 'hero' }}>
        <Figure model={cast.player} size={HERO} tint={color['sky-deep']} moving={() => memory.current.moving} />
      </group>
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
        <Figure model={bossModel} size={BIG} tint={color['tomato-deep']} moving={() => true} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
          <ringGeometry args={[BIG.w * 0.55, BIG.w * 0.68, 40]} />
          <meshBasicMaterial color={color.tomato} transparent opacity={0.8} depthWrite={false} />
        </mesh>
        <Html position={[0, BIG.h + 0.6, 0]} center pointerEvents="none" zIndexRange={[10, 0]}>
          <span ref={bossHp} className="sp-world-tag" data-testid="survivor-boss-hp" style={{ display: 'inline-block', width: 72, padding: 2, visibility: 'hidden' }}>
            <span ref={bossBar} style={{ display: 'block', height: 6, width: '100%', background: color.tomato, borderRadius: 3 }} />
          </span>
        </Html>
        <Html position={[0, BIG.h + 1.3, 0]} center pointerEvents="none" zIndexRange={[10, 0]}>
          <span ref={bossTag} className="sp-world-tag" data-testid="survivor-boss-warning" style={{ visibility: 'hidden' }} />
        </Html>
      </group>
      <DangerMarks strip={strip} ring={ring} />
      {Array.from({ length: POOL.shots }, (_, slot) => (
        <group
          key={`shot-${String(slot)}`}
          ref={(group) => {
            shots.current[slot] = group;
          }}
          visible={false}
        >
          {ammoModel === undefined ? (
            <mesh>
              <sphereGeometry args={[0.2, 12, 8]} />
              <meshStandardMaterial color={color.sun} emissive={color['sun-deep']} emissiveIntensity={0.8} />
            </mesh>
          ) : (
            <FittedModel id={ammoModel} w={0.45} h={0.45} d={0.45} fallback={color.sun} />
          )}
        </group>
      ))}
      {Array.from({ length: POOL.crystals }, (_, slot) => (
        <group
          key={`gem-${String(slot)}`}
          ref={(group) => {
            crystals.current[slot] = group;
          }}
          visible={false}
          userData={{ item: 'drop' }}
        >
          <FittedModel id={dropModel} w={0.5} h={0.55} d={0.5} fallback={color.sun} />
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]}>
            <ringGeometry args={[0.32, 0.42, 24]} />
            <meshStandardMaterial
              ref={(material) => {
                frames.current[slot] = material;
              }}
              color={color.ink}
              roughness={0.6}
            />
          </mesh>
        </group>
      ))}
      {Array.from({ length: POOL.orbs }, (_, slot) => (
        <mesh
          key={`orb-${String(slot)}`}
          ref={(mesh) => {
            orbs.current[slot] = mesh;
          }}
          visible={false}
        >
          <sphereGeometry args={[m(SURVIVOR.orb.w) / 2, 14, 10]} />
          <meshStandardMaterial color={color.tomato} emissive={color['tomato-deep']} emissiveIntensity={0.6} />
        </mesh>
      ))}
      <GhostSlot ghost={ghost} session={session} place={worldPlacement} />
    </>
  );
}
