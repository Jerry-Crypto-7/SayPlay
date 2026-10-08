import type { GameSpecV1 } from '../spec';
import { sceneModelOf } from './models';

/** The quest renderer and fidelity chain share the same named target choice.
 * Unknown labels keep the existing verb shape, which is not a named model.
 */
export function targetModelOf(spec: GameSpecV1, role = spec.roles.find(role => role.id === 'target')): string | undefined {
  const generator = spec.controlParams?.generator;
  if (generator !== 'quest_spatial' && generator !== 'quest_station') return undefined;
  if (role?.id !== 'target' || role.kind !== 'target') return undefined;
  const model = sceneModelOf(role.label, false);
  return model === 'bird' ? undefined : model;
}
