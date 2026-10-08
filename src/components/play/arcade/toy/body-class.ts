/**
 * Třída těla modelu scény (P45D T5): model katalogu ji má v `catalog-motion.json`
 * (T2), riggovaná postava podle třídy svého záznamu manifestu (`rigged.json`,
 * `rigged-p32.json`), primitiv ptáček létá, všechno ostatní je předmět.
 */

import motion from '@/assets/catalog-motion.json';
import { RIGGED_PREFIX } from '@/play/arcade/models';
import type { BodyClass } from '@/play/arcade/toy-motion';
import { BASE_ENTRIES } from '@/play/assets/entries/base';
import { RIGGED_P32_ENTRIES } from '@/play/assets/entries/rigged-p32';
import type { ModelClass } from '@/play/genre/contract';

/** Třída modelu → třída těla, stejně jako `scripts/p45d/motion-class.mjs` (`BODY_OF_CLASS`). */
const BODY_OF_CLASS: Readonly<Partial<Record<ModelClass, BodyClass>>> = {
  bird: 'flyer',
  aircraft: 'flyer',
  boat: 'vehicle',
  vehicle: 'vehicle',
  humanoid: 'biped',
  robot: 'biped',
  monster: 'biped',
  animal: 'quadruped',
};

/** Pohyblivý díl z `catalog-motion.json`: uzel GLB, role a pivot v prostoru modelu. */
export interface MotionPart {
  readonly id: string;
  readonly node: string;
  readonly role: string;
  readonly pivot: readonly [number, number, number];
}

/** Prahy oblastí deformace v jednotkách modelu (`scripts/p45d/motion-class.mjs` → `regionsOf`). */
export interface ToyRegions {
  readonly midX?: number;
  readonly wingX?: number;
  readonly tailZ?: number;
  readonly legY?: number;
}

export interface ModelMotion {
  readonly class: BodyClass;
  readonly parts?: readonly MotionPart[];
  readonly regions?: ToyRegions;
}

const MODELS = motion.models as unknown as Readonly<Record<string, ModelMotion>>;

/** Záznam pohybu modelu katalogu (T2); riggovaná postava ani primitiv ho nemají. */
export const motionOf = (modelId: string): ModelMotion | undefined => MODELS[modelId];
const RIGGED: ReadonlyMap<string, ModelClass> = new Map([...BASE_ENTRIES, ...RIGGED_P32_ENTRIES].map((entry) => [entry.id, entry.class]));

export function bodyClassOf(modelId: string): BodyClass {
  const id = modelId.startsWith(RIGGED_PREFIX) ? modelId.slice(RIGGED_PREFIX.length) : modelId;
  const listed = MODELS[id]?.class;
  if (listed !== undefined) return listed;
  const rigged = RIGGED.get(id);
  if (rigged !== undefined) return BODY_OF_CLASS[rigged] ?? 'prop';
  return id === 'bird' ? 'flyer' : 'prop';
}
