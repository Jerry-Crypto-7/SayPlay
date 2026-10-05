'use client';

/**
 * Hrdina dělá sloveso věty (P37B T2): obalí model hrdiny skupinou, která ho
 * pohne podle `heroAction`, a přidá rekvizitu v ruce s odletem (kapky,
 * třísky, prach, jiskry). Klidová smyčka běží pořád, nápřah spustí efekt
 * jádra, kterým hrdina něco udělal (`BURST_KINDS` z `session.onEvents` –
 * jen hra člověka, ukázka posluchače nevolá), a bez události pracovní takt
 * `WORK_BEAT_S`.
 *
 * `none` vrátí model beze změny stromu: běžec bere první dítě skupiny jako
 * vnitřní pózu a hra bez akce musí vypadat jako dřív. S akcí je prvním
 * dítětem tahle skupina – póza běžce ji nese, tělo akce je uvnitř.
 *
 * Jen obraz: čas z `useFrame`, do relace ani hashe nic nezapíše. Rekvizity
 * jsou jednoduchá geometrie v barvách kitu (`colorHex`).
 */

import { useFrame } from '@react-three/fiber';
import { type ReactNode, useEffect, useRef } from 'react';
import type { Group } from 'three';

import { colorHex } from '@/brand/tokens';
import { ARCADE_HZ } from '@/play/arcade/contract';
import { playHeroActionSfx } from '@/play/audio';
import type { HeroAction } from '@/play/spec';

import type { ArcadeSession } from '../session';
import { BURST_KINDS, BURST_S, type PropKind, type Spill, WORK_BEAT_S, motionOf } from './actions';

/** Ruka vpravo před tělem (podíl výšky): kamera za zády i z boku ji vidí. */
const HAND_X = 0.3;
const HAND_Z = 0.12;
/** Rekvizita přehnaně velká (kit Toy Box): v aréně je hrdina jen pár desítek pixelů. */
const PROP_SCALE = 1.5;
/** Odlet: počet kousků a jak dlouho jeden letí (s). */
const BITS = 6;
const BIT_S = 0.45;
const MAX_STEP_S = 0.1;
/** Nápřah z události se znovu spustí (a zazní) nejdřív po svém doběhnutí. */
const SWING_TICKS = Math.round(BURST_S * ARCADE_HZ);

const WOOD = colorHex['sun-deep'];
const METAL = colorHex['sky-deep'];
const DARK = colorHex['ink-soft'];

/** Pracovní konec rekvizity (podíl výšky, v souřadnicích rekvizity) – odtud letí odlet. */
const TIP: Readonly<Record<PropKind, readonly [number, number, number]>> = {
  spoon: [0, -0.38, 0],
  nozzle: [0, 0, 0.28],
  crate: [0, -0.15, 0],
  tray: [0, 0.04, 0],
  broom: [0, -0.5, 0],
  ball: [0, 0, 0],
  shovel: [0, -0.47, 0],
  brush: [0, 0.3, 0],
  axe: [0, 0.42, 0],
  can: [0, 0.05, 0.2],
  needles: [0, 0.12, 0],
  wrench: [0, 0.25, 0],
};

const SPILL_COLOR: Readonly<Record<Exclude<Spill, null>, number>> = {
  drops: colorHex.sky,
  chips: colorHex['sun-deep'],
  dust: colorHex['cream-deep'],
  sparks: colorHex.sun,
};

/** Násada: poloměry níž jsou věrné tvaru, v aréně by ale zanikly – kreslí se dvakrát silnější. */
const HANDLE_BOLD = 2;

function Stick({ from, to, r, color }: { readonly from: number; readonly to: number; readonly r: number; readonly color: number }) {
  return (
    <mesh position={[0, (from + to) / 2, 0]}>
      <cylinderGeometry args={[r * HANDLE_BOLD, r * HANDLE_BOLD, Math.abs(to - from), 8]} />
      <meshStandardMaterial color={color} roughness={0.6} />
    </mesh>
  );
}

/** Rekvizita v jednotkách výšky 1 (skupina nad ní ji zvětší na hrdinu); úchop je v počátku. */
function Prop({ kind }: { readonly kind: PropKind }) {
  switch (kind) {
    case 'spoon':
      return (
        <>
          <Stick from={0.05} to={-0.34} r={0.014} color={WOOD} />
          <mesh position={[0, -0.37, 0]} scale={[1, 0.6, 1]}>
            <sphereGeometry args={[0.07, 12, 8]} />
            <meshStandardMaterial color={WOOD} roughness={0.6} />
          </mesh>
        </>
      );
    case 'nozzle':
      return (
        <>
          <mesh position={[0, 0, 0.12]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.025, 0.035, 0.26, 10]} />
            <meshStandardMaterial color={colorHex.tomato} roughness={0.5} />
          </mesh>
          <mesh position={[0, -0.06, 0]}>
            <boxGeometry args={[0.04, 0.12, 0.05]} />
            <meshStandardMaterial color={DARK} roughness={0.6} />
          </mesh>
        </>
      );
    case 'crate':
      return (
        <mesh position={[0, 0, 0.05]}>
          <boxGeometry args={[0.3, 0.26, 0.26]} />
          <meshStandardMaterial color={WOOD} roughness={0.8} />
        </mesh>
      );
    case 'tray':
      return (
        <>
          <mesh>
            <cylinderGeometry args={[0.17, 0.17, 0.02, 20]} />
            <meshStandardMaterial color={colorHex.paper} roughness={0.4} />
          </mesh>
          <mesh position={[-0.06, 0.04, 0]}>
            <cylinderGeometry args={[0.05, 0.04, 0.07, 12]} />
            <meshStandardMaterial color={colorHex.tomato} roughness={0.5} />
          </mesh>
          <mesh position={[0.07, 0.03, 0.03]}>
            <cylinderGeometry args={[0.06, 0.06, 0.03, 12]} />
            <meshStandardMaterial color={colorHex.mint} roughness={0.5} />
          </mesh>
        </>
      );
    case 'broom':
      return (
        <>
          <Stick from={0.25} to={-0.42} r={0.015} color={WOOD} />
          <mesh position={[0, -0.47, 0]}>
            <boxGeometry args={[0.2, 0.1, 0.07]} />
            <meshStandardMaterial color={colorHex.sun} roughness={0.9} />
          </mesh>
        </>
      );
    case 'ball':
      return (
        <mesh>
          <sphereGeometry args={[0.07, 14, 10]} />
          <meshStandardMaterial color={colorHex.tomato} roughness={0.5} />
        </mesh>
      );
    case 'shovel':
      return (
        <>
          <Stick from={0.12} to={-0.38} r={0.015} color={WOOD} />
          <mesh position={[0, -0.45, 0]}>
            <boxGeometry args={[0.14, 0.17, 0.02]} />
            <meshStandardMaterial color={METAL} roughness={0.4} metalness={0.2} />
          </mesh>
        </>
      );
    case 'brush':
      return (
        <>
          <Stick from={-0.05} to={0.22} r={0.013} color={WOOD} />
          <mesh position={[0, 0.27, 0]}>
            <boxGeometry args={[0.1, 0.08, 0.04]} />
            <meshStandardMaterial color={colorHex.tomato} roughness={0.8} />
          </mesh>
        </>
      );
    case 'axe':
      return (
        <>
          <Stick from={-0.1} to={0.42} r={0.016} color={WOOD} />
          <mesh position={[0, 0.38, 0.06]}>
            <boxGeometry args={[0.03, 0.1, 0.13]} />
            <meshStandardMaterial color={METAL} roughness={0.4} metalness={0.2} />
          </mesh>
        </>
      );
    case 'can':
      return (
        <>
          <mesh>
            <cylinderGeometry args={[0.08, 0.08, 0.14, 14]} />
            <meshStandardMaterial color={colorHex['mint-deep']} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.03, 0.12]} rotation={[Math.PI / 3, 0, 0]}>
            <cylinderGeometry args={[0.012, 0.018, 0.16, 8]} />
            <meshStandardMaterial color={colorHex['mint-deep']} roughness={0.5} />
          </mesh>
        </>
      );
    case 'needles':
      return (
        <>
          <mesh rotation={[0, 0, 0.5]}>
            <cylinderGeometry args={[0.018, 0.018, 0.34, 6]} />
            <meshStandardMaterial color={colorHex.cream} roughness={0.4} />
          </mesh>
          <mesh rotation={[0, 0, -0.5]}>
            <cylinderGeometry args={[0.018, 0.018, 0.34, 6]} />
            <meshStandardMaterial color={colorHex.cream} roughness={0.4} />
          </mesh>
          <mesh position={[0, -0.1, 0.02]}>
            <sphereGeometry args={[0.07, 14, 10]} />
            <meshStandardMaterial color={colorHex.bubblegum} roughness={0.9} />
          </mesh>
        </>
      );
    case 'wrench':
      return (
        <>
          <mesh position={[0, 0.1, 0]}>
            <boxGeometry args={[0.06, 0.26, 0.03]} />
            <meshStandardMaterial color={METAL} roughness={0.4} metalness={0.2} />
          </mesh>
          <mesh position={[0, 0.25, 0]}>
            <torusGeometry args={[0.05, 0.025, 6, 12, Math.PI * 1.5]} />
            <meshStandardMaterial color={METAL} roughness={0.4} metalness={0.2} />
          </mesh>
        </>
      );
  }
}

export function HeroActionBody({
  action,
  session,
  h,
  children,
}: {
  readonly action: HeroAction;
  readonly session: Pick<ArcadeSession, 'onEvents'>;
  /** Výška hrdiny (m). */
  readonly h: number;
  readonly children: ReactNode;
}) {
  const motion = motionOf(action);
  const body = useRef<Group>(null);
  const prop = useRef<Group>(null);
  const bits = useRef<(Group | null)[]>([]);
  const clock = useRef({ t: 0, burstAt: -Infinity, pending: false, swingTick: -Infinity });

  useEffect(() => {
    if (motion === null) return undefined;
    return session.onEvents((events, tick) => {
      if (!events.some((event) => BURST_KINDS.has(event.kind))) return;
      // Nový nápřah až po doběhnutí předchozího (P37B T9): opravář v továrně dostával
      // `count` skoro každý tik – zvuk hrál ~50× za sekundu a nápřah nikdy nedoběhl.
      // Tik menší než poslední = hra začala znovu.
      const now = clock.current;
      if (tick >= now.swingTick && tick - now.swingTick < SWING_TICKS) return;
      now.swingTick = tick;
      now.pending = true;
      // Nápřah z události zní (P37B T5); klidový pracovní takt mlčí.
      playHeroActionSfx(action);
    });
  }, [session, motion, action]);

  useFrame((_, delta) => {
    if (motion === null || body.current === null || prop.current === null) return;
    const now = clock.current;
    now.t += Math.min(delta, MAX_STEP_S);
    if (now.pending || now.t - now.burstAt >= WORK_BEAT_S) {
      now.burstAt = now.t;
      now.pending = false;
    }
    const u = Math.min(1, (now.t - now.burstAt) / BURST_S);
    const p = motion.pose(now.t, u);
    body.current.position.y = p.bob * h;
    body.current.rotation.set(p.pitch, p.yaw, p.roll);
    prop.current.position.set(p.x, p.y, p.z);
    prop.current.rotation.set(p.rx, p.ry, p.rz);
    for (let index = 0; index < BITS; index += 1) {
      const bit = bits.current[index];
      if (bit === undefined || bit === null) continue;
      const phase = (now.t / BIT_S + index / BITS) % 1;
      bit.visible = p.spill > 0.05;
      if (!bit.visible) continue;
      const side = Math.sin(index * 2.4);
      // Kapky padají dopředu a dolů, třísky a prach vyletí do stran a nahoru, jiskry rozprsknou.
      if (motion.spill === 'drops') bit.position.set(side * 0.03, -0.35 * phase * phase, 0.08 + 0.3 * phase);
      else bit.position.set(side * 0.25 * phase, 0.25 * phase - 0.35 * phase * phase, Math.cos(index * 2.4) * 0.2 * phase);
      bit.scale.setScalar(p.spill * (1 - phase) + 0.001);
    }
  });

  if (motion === null) return <>{children}</>;
  const tip = TIP[motion.prop];
  return (
    <group>
      <group ref={body}>
        {children}
        <group position={[HAND_X * h, motion.hand * h, HAND_Z * h]} scale={h * PROP_SCALE}>
          <group ref={prop}>
            <Prop kind={motion.prop} />
            {motion.spill !== null && (
              <group position={[...tip]}>
                {Array.from({ length: BITS }, (_, index) => (
                  <group key={index} ref={(group) => { bits.current[index] = group; }} visible={false}>
                    <mesh>
                      {motion.spill === 'drops' ? <sphereGeometry args={[0.022, 6, 4]} /> : <boxGeometry args={[0.03, 0.03, 0.03]} />}
                      <meshBasicMaterial color={action === 'paint' ? colorHex.tomato : SPILL_COLOR[motion.spill!]} />
                    </mesh>
                  </group>
                ))}
              </group>
            )}
          </group>
        </group>
      </group>
    </group>
  );
}
