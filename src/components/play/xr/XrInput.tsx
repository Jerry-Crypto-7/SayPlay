'use client';

import { useFrame } from '@react-three/fiber';
import { type XRControllerState, useXRInputSourceState } from '@react-three/xr';
import { type RefObject, useEffect, useMemo, useRef } from 'react';

import { baseControlOf } from '@/play/arcade/addons';
import { type ArcadeWorld, nativeRule } from '@/play/arcade/contract';
import { stageOf } from '@/play/compose/stage-registry';
import { DEAD_ZONE, type Pad, type XrControl, type XrMotion, createXrDriver } from '@/play/xr/input-map';

import { abilitiesOf, actionsOf } from '../arcade/ActionButton';
import { hasBlaster } from '../arcade/ArcadeStage';
import { glideShoots } from '../arcade/glide/glide-input';
import type { ReadyGate } from '../arcade/ready-gate';
import type { ArcadeSession } from '../arcade/session';
import { driveModeOf } from '../arcade/steer/SteerScene';

/** Co ovládání hry čte – stejné otázky, které klade `ArcadeStage`, když zapíná klávesnici. */
export function xrControlOf(world: ArcadeWorld): XrControl | null {
  const kind = baseControlOf(world.control).id;
  const input = stageOf(kind)?.input;
  if (input === undefined) return null;
  const abilities = abilitiesOf(world);
  const actions = actionsOf(world).filter((action) => action !== 'attack' || !abilities.includes('strike'));
  return {
    input,
    fire: hasBlaster(world.rules),
    attack: actions.includes('attack'),
    use: actions.includes('use'),
    abilities: abilities.length,
    drive: input === 'steer' ? driveModeOf(world) : undefined,
    glideShoots: input === 'glide' ? glideShoots(world) : undefined,
    swing: input !== 'lanes' ? undefined : nativeRule(world.rules, 'slice_cut') !== undefined ? 'slice' : nativeRule(world.rules, 'whack_hit') !== undefined ? 'whack' : undefined,
  };
}

const pressed = (controller: XRControllerState | undefined, id: string): boolean => controller?.gamepad[id]?.state === 'pressed';

/** Oba ovladače jako jedna „klávesnice“; páčka levého, když je vychýlená, jinak pravého. `null` = žádný ovladač. */
function padOf(left: XRControllerState | undefined, right: XRControllerState | undefined): Pad | null {
  if (left === undefined && right === undefined) return null;
  const leftStick = left?.gamepad['xr-standard-thumbstick'];
  const stick = Math.hypot(leftStick?.xAxis ?? 0, leftStick?.yAxis ?? 0) > DEAD_ZONE ? leftStick : right?.gamepad['xr-standard-thumbstick'];
  return {
    x: stick?.xAxis ?? 0,
    // Gamepad API: páčka od sebe = záporné y.
    y: -(stick?.yAxis ?? 0),
    trigger: pressed(left, 'xr-standard-trigger') || pressed(right, 'xr-standard-trigger'),
    a: pressed(right, 'a-button') || pressed(left, 'x-button'),
    b: pressed(right, 'b-button') || pressed(left, 'y-button'),
    grip: pressed(left, 'xr-standard-squeeze') || pressed(right, 'xr-standard-squeeze'),
  };
}

const active = (pad: Pad): boolean => pad.trigger || pad.a || pad.b || pad.grip || Math.hypot(pad.x, pad.y) > DEAD_ZONE;

/**
 * Ovladače → hra, která právě hraje (P65 T2). Čte gamepady každý snímek a volá `press` / `hold` / `holdButtons`
 * přes `input-map`, jako klávesnice; čas dál vlastní akumulátor relace. První vstup pustí hodiny jako první
 * ťuk nebo klávesa (`ReadyGate.begin`).
 */
export function XrInput({ session, motion }: { readonly session: ArcadeSession; readonly motion: RefObject<XrMotion> }) {
  const left = useXRInputSourceState('controller', 'left');
  const right = useXRInputSourceState('controller', 'right');
  const driver = useMemo(() => {
    const control = xrControlOf(session.world);
    return control === null ? null : createXrDriver(session, control);
  }, [session]);
  const started = useRef(false);
  useEffect(() => () => driver?.frame(null), [driver]);
  useFrame(() => {
    if (driver === null) return;
    const pad = padOf(left, right);
    if (!started.current && pad !== null && active(pad)) {
      started.current = true;
      (session as Partial<ReadyGate>).begin?.();
    }
    driver.frame(pad, motion.current);
  });
  return null;
}
