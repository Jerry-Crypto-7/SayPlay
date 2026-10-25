'use client';

import { renderHeld } from '../effects/render-feel';

/**
 * Scéna souboje zblízka (P25H T5): pohled z boku, hráč vlevo, soupeř
 * vpravo. Fáze soupeře (`aux0`) je vidět na barvě i póze – nápřah je
 * jantarový s rukou nahoře (uhni), mezera zelená s pokleslou rukou (udeř),
 * úder soupeře ruku švihne dolů. Hráč se při úhybu přikrčí (výška z jádra)
 * a při úderu natáhne ruku. `z` hráče je počítadlo zásahů, kreslí se na místě.
 * Bojovník s modelem (P45D T10) hraje místo toho hračkový pohyb: úder = nápřah
 * a výpad k soupeři, úhyb = přikrčení, zásah, pád, výhra.
 * Šampion (P47A T10): když tělo soupeře převezme větší rozměry předlohy šampiona
 * (`duel.champion`), soupeř se kreslí v nich a kamera ho i s pipy HP nad hlavou
 * vezme celého – bez animace, změna přijde s úderem, který porazil předposledního.
 * Hozená věc (P51 T6, `duel.hurl`): míček z primitiv střelnice v poloze svého těla, dokud žije –
 * v nápřahu nad hlavou soupeře, po švihu letí k hráči.
 * Povel chvíle (P58C T6b): štítek kitu nad soupeřem „Dodge!“ těsně před zásahem a „Strike!“ v mezeře – porotce
 * barvu ruky modelu nepostřehl (`duelCue`, načasování hlídá `duel.test.ts`).
 *
 * Vstup: mezerník / Enter / šipka nahoru nebo ťuk do pravé půlky = úder;
 * šipka dolů / S nebo ťuk do levé půlky = úhyb.
 */

import { Html } from '@react-three/drei/web/Html';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { Group, MeshStandardMaterial, PerspectiveCamera } from 'three';
import { Vector3 } from 'three';

import { BODY, BUTTON, FLAG, HEADER, RUN_STATE, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { DUEL, DUEL_FOE, DUEL_PHASE, type DuelCue, duelCue, duelHurlOf } from '@/play/arcade/pieces/duel';
import { type BodyClass, type ToyPose, toyPoseOf, toyViewOf } from '@/play/arcade/toy-motion';
import type { HeroAction } from '@/play/spec';

import { type ArcadeGhost, GhostSlot, besideHero } from '../GhostSlot';
import { isTyping } from '../input';
import { HorizonBackdrop } from '../look/Backdrop';
import { FieldGround } from '../look/FieldGround';
import { Landmark } from '../look/Landmark';
import type { Volume } from '../look/landmark-places';
import { HeroActionBody } from '../hero-action/HeroActionBody';
import { InkOutline } from '../look/rig/InkOutline';
import { Scenery } from '../look/Scenery';
import type { ArcadeSession } from '../session';
import { ShotPrimitive } from '../shooter/primitives';
import { DUEL_ZONES, zoneAt } from '../touch-zones';
import { initialBody } from '../timing/TimingScene';
import { applyToy, toyMotionOn, toyTickOf } from '../toy/applyToy';

const STRIKE_KEYS = new Set([' ', 'enter', 'arrowup', 'w']);
const DODGE_KEYS = new Set(['arrowdown', 's']);
const STRIKE_TICKS = 10;
/** Nejbližší vrstva kulisy za mlhou (m): boční kamera 5–8 m před ringem, kulisy 4–9 m za ním. */
const BACKDROP_BEYOND = 22;
/** Potácení po vykrytém úderu: náklon k soupeři (rad). */
const STAGGER_LEAN = 0.25;
/** Bojovníci stojí na místě: třída těla tvaruje jen chůzi, kterou souboj nemá (a model sem přijde bez jména). */
const FIGHTER: BodyClass = 'biped';
/** Záběr ringu na výšku (m): aspoň `tall`, se šampionem jeho výška a místo na pipy HP nad hlavou. */
const FRAME = { tall: 3.2, overHead: 1.4, lookY: 1.1, below: 0.5 } as const;

export function useDuelInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const button = STRIKE_KEYS.has(key) ? BUTTON.TAP : DODGE_KEYS.has(key) ? BUTTON.DOWN : 0;
      if (button === 0) return;
      event.preventDefault();
      session.press(button);
    };
    const onDown = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      session.press(zoneAt(DUEL_ZONES, (event.clientX - box.left) / Math.max(1, box.width)) === 1 ? BUTTON.TAP : BUTTON.DOWN);
    };
    window.addEventListener('keydown', onKey);
    element.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      element.removeEventListener('pointerdown', onDown);
    };
  }, [session, target, active]);
}

// Barva soupeře podle fáze; nic fialového.
const PHASE_COLOR: Readonly<Record<number, string>> = {
  [DUEL_PHASE.ready]: '#64748b',
  [DUEL_PHASE.windup]: '#f59e0b',
  [DUEL_PHASE.open]: '#16a34a',
  [DUEL_PHASE.struck]: '#dc2626',
};

/** Ruka soupeře podle fáze v ringu (soupeř hledí k −z): nápřah ji zvedne za hlavu, těsně před úderem švihne k hráči, v mezeře visí. */
const foeArmOf = (phase: number, left: number): number => (phase === DUEL_PHASE.windup ? (left <= 4 ? Math.PI / 2 : -Math.PI * 0.8) : phase === DUEL_PHASE.open ? 0.1 : 0);
/** Náklon soupeře podle fáze v ringu: nápřah dozadu, mezera k hráči. */
const foeLeanOf = (phase: number): number => (phase === DUEL_PHASE.open ? -0.2 : phase === DUEL_PHASE.windup ? 0.12 : 0);

interface Fighter {
  readonly body: React.RefObject<Group | null>;
  readonly arm: React.RefObject<Group | null>;
  readonly material: React.RefObject<MeshStandardMaterial | null>;
}

/** Rameno je kloub: ruka visí dolů a otáčí se k soupeři (`toward` ±1 po z rodičovské skupiny). */
function Arm({ fighter, color, toward, w, torso }: { readonly fighter: Fighter; readonly color: string; readonly toward: 1 | -1; readonly w: number; readonly torso: number }) {
  return (
    <group ref={fighter.arm} position={[0, torso * 0.9, toward * w * 0.3]}>
      <mesh position={[0, -torso * 0.35, 0]}>
        <boxGeometry args={[w * 0.2, torso * 0.7, w * 0.2]} />
        <meshStandardMaterial color={color} roughness={0.6} />
      </mesh>
      <mesh position={[0, -torso * 0.72, 0]}>
        <sphereGeometry args={[w * 0.16, 12, 8]} />
        <meshStandardMaterial color="#f8fafc" roughness={0.5} />
      </mesh>
    </group>
  );
}

/** Postava z primitiv: trup, hlava a jedna ruka, která míří k soupeři (`facing` ±1 po z). */
function Figure({ fighter, color, facing, w, h }: { readonly fighter: Fighter; readonly color: string; readonly facing: 1 | -1; readonly w: number; readonly h: number }) {
  const torso = h * 0.62;
  const head = h * 0.14;
  return (
    <group ref={fighter.body}>
      <mesh position={[0, torso / 2, 0]}>
        <boxGeometry args={[w * 0.7, torso, w * 0.55]} />
        <meshStandardMaterial ref={fighter.material} color={color} roughness={0.6} />
      </mesh>
      <mesh position={[0, torso + head * 1.1, 0]}>
        <sphereGeometry args={[head, 16, 12]} />
        <meshStandardMaterial color="#fcd34d" roughness={0.7} />
      </mesh>
      <Arm fighter={fighter} color={color} toward={facing} w={w} torso={torso} />
    </group>
  );
}

/**
 * Bojovník s modelem z popisku (P27A T4, P43 T14b): model leží ve skupině pózy natočené
 * k soupeři (`heading` kolem y), hračkový pohyb (P45D T10) ji posune výpadem po jejím +z.
 * Ruku z primitiv nemá ani soupeř (P58C T6b): u malého modelu stála jako tyč, kterou porotci brali za chybu
 * kreslení – kdy uhnout a kdy udeřit říká štítek povelu nad ním.
 */
function ModelFigure({ fighter, heading, children }: { readonly fighter: Fighter; readonly heading: number; readonly children: React.ReactNode }) {
  return (
    <group ref={fighter.body} rotation={[0, heading, 0]}>
      {children}
    </group>
  );
}

/** Model bojovníka vepsaný do jeho těla (m); scéna arkády ho dodá, když popisek model jmenuje. */
export type RivalModel = (w: number, h: number, d: number) => React.ReactNode;

/** Štítek povelu nad soupeřem (kit `.sp-world-tag`): úhyb rajčatově jako hrozba, úder slunečně jako cíl. */
const CUE_TAG: Readonly<Record<NonNullable<DuelCue>, { readonly text: string; readonly className: string }>> = {
  dodge: { text: 'Dodge!', className: 'sp-world-tag' },
  strike: { text: 'Strike!', className: 'sp-world-tag sp-world-tag--goal' },
};
/** Štítek nad hlavou soupeře (m): nad zdviženou rukou, pod bannerem průběhu (24 % výšky) i na desktopu. */
const CUE_OVER_HEAD = 0.25;

export function DuelScene({
  session,
  look: scene,
  heroModel,
  rivalModel,
  heroAction,
  ghost,
}: {
  readonly session: ArcadeSession;
  readonly look: Look;
  /** P43 T14b: hrdina z věty (rytíř, pirát) místo kvádru; úder hraje hračkový pohyb (P45D T10), ne ruka z primitiv. */
  readonly heroModel?: RivalModel;
  readonly rivalModel?: RivalModel;
  readonly heroAction: HeroAction;
  readonly ghost?: ArcadeGhost;
}) {
  const world = session.world;
  const hero = initialBody(world, 0);
  // Boční kamera vidí ring podél z: duch stojí za hrdinou, dál od soupeře.
  const ghostSpot = useMemo(() => besideHero(0, hero.z, hero.w / 2, 'z'), [hero.z, hero.w]);
  const rival = initialBody(world, DUEL_FOE);
  const player: Fighter = { body: useRef(null), arm: useRef(null), material: useRef(null) };
  const foe: Fighter = { body: useRef(null), arm: useRef(null), material: useRef(null) };
  const lastStrike = useRef(-STRIKE_TICKS);
  // Hračková póza bojovníků s modelem (P45D T10) s pamětí minulého snímku; tik kvůli restartu.
  const heroToy = useRef<ToyPose | null>(null);
  const rivalToy = useRef<ToyPose | null>(null);
  const lastTick = useRef(0);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look = useMemo(() => new Vector3(), []);
  const midZ = rival.z / 2;
  const duelLand = useMemo(() => ({ x0: -30, x1: 30, z0: midZ - 30, z1: midZ + 30 }), [midZ]);
  /** Ring 4 × 9 m: orientační bod za ním, rámující kusy před ním u kraje obrazu (P54B T8). */
  const ring = useMemo(() => [{ x0: -2, x1: 2, z0: midZ - 4.5, z1: midZ + 4.5 }], [midZ]);
  /** Rytíři chodí po celém ringu: bod nesmí stát v obraze za kterýmkoli místem, kde mohou být (P54B T15a), ne jen za tím, kde začali. */
  const ringPlay = useMemo<Volume[]>(() => [{ x0: -2, y0: 0, z0: midZ - 4.5, x1: 2, y1: 1.25 * Math.max(hero.h, rival.h), z1: midZ + 4.5 }], [midZ, hero.h, rival.h]);
  const hurl = duelHurlOf(world.control);
  const hurlBody = hurl?.body;
  const hurlSize = hurlBody === undefined ? null : initialBody(world, hurlBody);
  const hurled = useRef<Group>(null);
  const cueAt = useRef<Group>(null);
  const cueTag = useRef<HTMLSpanElement>(null);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const tick = state[HEADER.tick] as number;
    if (tick < lastTick.current) {
      lastStrike.current = -STRIKE_TICKS;
      heroToy.current = null;
      rivalToy.current = null;
    }
    lastTick.current = tick;
    const playerIndex = state[HEADER.player] as number;
    const p = bodyBase(playerIndex);
    const f = bodyBase(DUEL_FOE);
    const phase = state[f + BODY.aux0] as number;
    const left = state[f + BODY.aux1] as number;
    // Úder hráče v mezeře zasáhl soupeře v tomhle tiku.
    const struck = (state[p + BODY.aux0] as number) > 0;
    if (struck) lastStrike.current = tick;
    const crouch = (state[p + BODY.h] as number) / UNIT / hero.h;
    const timer = state[p + BODY.aux1] as number;
    const stagger = timer < -DUEL.cooldown ? STAGGER_LEAN : 0;
    // Póza jen čte stav a tik s podílem; pod `prefers-reduced-motion` ukáže stav okamžitě.
    const toyTick = toyTickOf(session);
    const reduced = !toyMotionOn();
    const runState = state[HEADER.runState] as number;

    if (heroModel === undefined) {
      // Panák: přikrčení z výšky jádra, natažená ruka chvíli po úderu, potácení = náklon.
      if (player.body.current !== null) {
        player.body.current.scale.y = crouch;
        player.body.current.rotation.x = stagger;
      }
      if (player.arm.current !== null) player.arm.current.rotation.x = tick - lastStrike.current < STRIKE_TICKS ? -Math.PI / 2 : -0.2;
    } else if (player.body.current !== null) {
      // Hrdina s modelem: úder = nápřah a výpad k soupeři, úhyb = zmáčknutí na výšku jádra, potácení = předklon.
      const toy = toyPoseOf({ ...toyViewOf(state, prev, playerIndex), attack: struck }, FIGHTER, heroToy.current, toyTick, reduced);
      heroToy.current = toy;
      applyToy({ group: player.body.current }, { ...toy, squash: toy.squash + 1 - crouch, pitch: toy.pitch + stagger }, hero.h);
    }

    if (rivalModel === undefined) {
      // Soupeř: nápřah zvedá ruku dozadu nad hlavu, úder ji švihne k hráči, mezera ji nechá viset.
      if (foe.arm.current !== null) foe.arm.current.rotation.x = foeArmOf(phase, left);
      if (foe.body.current !== null) foe.body.current.rotation.x = foeLeanOf(phase);
    } else {
      // Skupina pózy soupeře s modelem je otočená o π k hráči: úhly kolem x v ní mají opačné znaménko než v ringu.
      if (foe.body.current !== null) {
        const view = toyViewOf(state, prev, DUEL_FOE);
        const toy = toyPoseOf(
          {
            ...view,
            // Úder soupeře = konec nápřahu; zásah = úder hráče v mezeře; padne s výhrou hráče, slaví jeho prohru.
            attack: phase === DUEL_PHASE.open && (prev[f + BODY.aux0] as number) === DUEL_PHASE.windup,
            hit: struck,
            alive: view.alive && runState !== RUN_STATE.won,
            won: runState === RUN_STATE.lost,
          },
          FIGHTER,
          rivalToy.current,
          toyTick,
          reduced,
        );
        rivalToy.current = toy;
        applyToy({ group: foe.body.current }, { ...toy, pitch: toy.pitch - foeLeanOf(phase) }, rival.h, Math.PI);
      }
    }
    foe.material.current?.color.set(PHASE_COLOR[phase] ?? '#64748b');
    if (hurlBody !== undefined && hurled.current !== null) {
      // Hozená věc: poloha těla mezi tiky; věc, která v minulém tiku nežila, se objeví rovnou v ruce (ne z místa minulého zásahu).
      const h = bodyBase(hurlBody);
      const live = ((state[h + BODY.flags] as number) & FLAG.alive) !== 0;
      const was = ((prev[h + BODY.flags] as number) & FLAG.alive) !== 0;
      hurled.current.visible = live;
      const at = (slot: number): number => (was ? (prev[h + slot] as number) + ((state[h + slot] as number) - (prev[h + slot] as number)) * alpha : (state[h + slot] as number)) / UNIT;
      if (live) hurled.current.position.set(at(BODY.x), at(BODY.y), at(BODY.z));
    }
    // Šampion: tělo soupeře má za běhu rozměry předlohy šampiona – model i postava z primitiv rostou s ním. Měřítko
    // nese skupina soupeře v ringu (rodič skupiny pózy): pózu a její zmáčknutí si skupina pózy píše sama (`applyToy`).
    const foeH = (state[f + BODY.h] as number) / UNIT;
    foe.body.current?.parent?.scale.set((state[f + BODY.w] as number) / UNIT / rival.w, foeH / rival.h, (state[f + BODY.d] as number) / UNIT / rival.d);
    // Povel chvíle (P58C T6b) nad hlavou soupeře – i šampiona, který mezitím vyrostl.
    cueAt.current?.position.setY(foeH + CUE_OVER_HEAD);
    const tag = cueTag.current;
    if (tag !== null) {
      const cue = duelCue(state, hurl);
      const text = cue === null ? '' : CUE_TAG[cue].text;
      if (tag.textContent !== text) tag.textContent = text;
      if (cue !== null && tag.className !== CUE_TAG[cue].className) tag.className = CUE_TAG[cue].className;
      tag.style.visibility = cue === null ? 'hidden' : 'visible';
    }

    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const tall = Math.max(FRAME.tall, foeH + FRAME.overHead);
    const dist = Math.max(6 / (2 * tan * camera.aspect), tall / (2 * tan), 5);
    const lookY = Math.max(FRAME.lookY, tall / 2 - FRAME.below);
    camera.position.set(-dist, lookY + 0.3, midZ);
    look.set(0, lookY, midZ);
    camera.lookAt(look);
  });

  return (
    <>
      {/* Obloha, mlha, světla, stín a ladění jsou rigu (`look/rig/StyleRig.tsx`, P37B T3). */}
      {/* Prostředí (P27A T4): zem sady a kulisy za ringem – boční kamera na −x je vidí za soupeři. */}
      {/* Zem s odstíny a skvrnami (P46G T7); vegetace ne – ring s boční kamerou má za soupeři jen řadu kulis. */}
      <FieldGround look={scene} area={duelLand} y={-0.12} under />
      <Scenery look={scene} layout="behind" inner={4} from={midZ - 12} to={midZ + 12} />
      {/* Kulisa za mlhou za řadou kulis (4–9 m za ringem). */}
      <HorizonBackdrop look={scene} seed={session.world.seed} clear={0} beyond={BACKDROP_BEYOND} />
      <Landmark look={scene} seed={session.world.seed} area={ring} play={ringPlay} />
      <mesh position={[0, -0.1, midZ]}>
        <boxGeometry args={[4, 0.2, 9]} />
        <meshStandardMaterial color="#78716c" roughness={0.95} />
      </mesh>
      {/* Sonda záběru (P27A T6): hráč je hrdina, soupeř cíl. */}
      <group position={[0, 0, hero.z]} userData={{ frame: 'hero' }}>
        <InkOutline ink="hero" />
        {/* Činnost hrdiny (P37B T2) – `none` nechá postavu beze změny stromu. */}
        <HeroActionBody action={heroAction} session={session} h={hero.h}>
          {heroModel === undefined ? (
            <Figure fighter={player} color="#2563eb" facing={1} w={hero.w} h={hero.h} />
          ) : (
            <ModelFigure fighter={player} heading={0}>
              {heroModel(hero.w, hero.h, hero.d)}
            </ModelFigure>
          )}
        </HeroActionBody>
      </group>
      {/* Slot ducha (P37-0 T3) vedle hrdiny, ne v jeho skupině. */}
      <GhostSlot ghost={ghost} session={session} place={ghostSpot} />
      <group position={[0, 0, rival.z]} userData={{ frame: 'target', item: 'rival' }}>
        <InkOutline ink="foe" />
        {/* Model hledí k hráči (−z): skupinu pózy natočí o π `ModelFigure` i `applyToy`. */}
        {rivalModel === undefined ? (
          <Figure fighter={foe} color={PHASE_COLOR[DUEL_PHASE.ready]!} facing={-1} w={rival.w} h={rival.h} />
        ) : (
          <ModelFigure fighter={foe} heading={Math.PI}>
            {rivalModel(rival.w, rival.h, rival.d)}
          </ModelFigure>
        )}
      </group>
      {hurlSize !== null && (
        <group ref={hurled} visible={false}>
          <ShotPrimitive id="ball" w={hurlSize.w} h={hurlSize.h} d={hurlSize.d} />
        </group>
      )}
      <group ref={cueAt} position={[0, rival.h + CUE_OVER_HEAD, rival.z]}>
        <Html center pointerEvents="none" zIndexRange={[10, 0]}>
          <span ref={cueTag} className="sp-world-tag" data-testid="duel-cue" style={{ visibility: 'hidden' }} />
        </Html>
      </group>
    </>
  );
}
