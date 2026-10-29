'use client';

import { useFrame } from '@react-three/fiber';
import { type XRControllerState, useXRInputSourceState } from '@react-three/xr';
import { type RefObject, useEffect, useMemo } from 'react';

import { baseControlOf } from '@/play/arcade/addons';
import { type ArcadeWorld, nativeRule } from '@/play/arcade/contract';
import { stageOf } from '@/play/compose/stage-registry';
import { DEAD_ZONE, type Pad, type XrControl, type XrMotion, createTriggerOwner, createXrDriver } from '@/play/xr/input-map';

import { abilitiesOf, actionsOf } from '../arcade/ActionButton';
import { hasBlaster } from '../arcade/ArcadeStage';
import { glideShoots } from '../arcade/glide/glide-input';
import type { ReadyGate } from '../arcade/ready-gate';
import type { ArcadeSession } from '../arcade/session';
import { driveModeOf } from '../arcade/steer/SteerScene';
import { type PanelAim, aimsAtPanel } from './XrPanel';

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
    handLane: input === 'lanes' && nativeRule(world.rules, 'catch_fall') !== undefined ? true : undefined,
  };
}

const pressed = (controller: XRControllerState | undefined, id: string): boolean => controller?.gamepad[id]?.state === 'pressed';

/**
 * Oba ovladače jako jedna „klávesnice“; páčka levého, když je vychýlená, jinak pravého. `null` = žádný ovladač.
 * Grip jen pravého: levý nese desku dioramy (T4, `Diorama`), a to je pohled, ne vstup hry. Spoušť stisknutá
 * s paprskem na tlačítku panelu HUD (T5) patří panelu, ne hře (`trigger`).
 */
function padOf(left: XRControllerState | undefined, right: XRControllerState | undefined, trigger: (hand: XRHandedness, down: boolean) => boolean): Pad | null {
  if (left === undefined && right === undefined) return null;
  const leftStick = left?.gamepad['xr-standard-thumbstick'];
  const stick = Math.hypot(leftStick?.xAxis ?? 0, leftStick?.yAxis ?? 0) > DEAD_ZONE ? leftStick : right?.gamepad['xr-standard-thumbstick'];
  // Obě ruce vždy: vlastník stisku se pamatuje jen přes snímek, kdy ho ruka drží.
  const leftTrigger = trigger('left', pressed(left, 'xr-standard-trigger'));
  const rightTrigger = trigger('right', pressed(right, 'xr-standard-trigger'));
  return {
    x: stick?.xAxis ?? 0,
    // Gamepad API: páčka od sebe = záporné y.
    y: -(stick?.yAxis ?? 0),
    trigger: leftTrigger || rightTrigger,
    a: pressed(right, 'a-button') || pressed(left, 'x-button'),
    b: pressed(right, 'b-button') || pressed(left, 'y-button'),
    grip: pressed(right, 'xr-standard-squeeze'),
  };
}

const active = (pad: Pad): boolean => pad.trigger || pad.a || pad.b || pad.grip || Math.hypot(pad.x, pad.y) > DEAD_ZONE;

/**
 * Ovladače → hra, která právě hraje (P65 T2). Čte gamepady každý snímek a volá `press` / `hold` / `holdButtons`
 * přes `input-map`, jako klávesnice; čas dál vlastní akumulátor relace. Vstup pustí hodiny čekající hry jako ťuk
 * nebo klávesa (`ReadyGate.begin`) – první běh i každý další po „Again“ (T5), který čeká znovu. `aim` = paprsky
 * na tlačítkách panelů HUD (`XrPanel`).
 */
export function XrInput({ session, motion, aim }: { readonly session: ArcadeSession; readonly motion: RefObject<XrMotion>; readonly aim: PanelAim }) {
  const left = useXRInputSourceState('controller', 'left');
  const right = useXRInputSourceState('controller', 'right');
  const driver = useMemo(() => {
    const control = xrControlOf(session.world);
    return control === null ? null : createXrDriver(session, control);
  }, [session]);
  const owner = useMemo(() => createTriggerOwner(), []);
  useEffect(() => () => driver?.frame(null), [driver]);
  useFrame(() => {
    if (driver === null) return;
    const pad = padOf(left, right, (hand, down) => owner(hand, down, aimsAtPanel(aim, hand)));
    const gate = session as Partial<ReadyGate>;
    if (pad !== null && active(pad) && gate.waiting?.() === true) gate.begin?.();
    driver.frame(pad, motion.current);
  });
  return null;
}
