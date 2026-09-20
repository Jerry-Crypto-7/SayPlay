/**
 * Registr kompilačních adaptérů (P23-A). `null` = registr mechaniku zná,
 * kompilátor ještě ne → `compileSim` odmítne spec s `MECHANIC_UNSUPPORTED`
 * (fail closed), nikdy ji tiše nevynechá.
 */

import type { MechanicId } from '../../registry';
import type { MechanicAdapter } from '../types';
import { checkpoint } from './checkpoint';
import { collectible } from './collectible';
import { counter } from './counter';
import { hazardZone } from './hazard-zone';
import { health } from './health';
import { lockKey } from './lock-key';
import { switchAdapter } from './switch';
import { timer } from './timer';
import { zoneTrigger } from './zone-trigger';

export const ADAPTERS: Readonly<Record<MechanicId, MechanicAdapter<never> | null>> = {
  collectible,
  counter,
  timer,
  zone_trigger: zoneTrigger,
  checkpoint,
  lock_key: lockKey,
  switch: switchAdapter,
  hazard_zone: hazardZone,
  chaser: null,
  patrol: null,
  carry: null,
  stun: null,
  spawn_wave: null,
  property_transform: null,
  health,
  defeat: null,
};

export type AdapterTable = typeof ADAPTERS;
