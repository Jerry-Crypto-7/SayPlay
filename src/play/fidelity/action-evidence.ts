import type { ArcadeWorld } from '../arcade/contract';
import { arcadeWorldOf, preloadPhysics } from '../arcade/compile';
import { loadRapier } from '../arcade/physics/world';
import { verifyArcade } from '../arcade/verify';
import { worldHasPhysics } from '../arcade/kernel';
import { bindRoles, matchesWitness, type ActionWitness } from '../arcade/witness';
import { essentialTriples, type Intent, type IntentTriple } from '../intent/contract';
import type { GameSpecV1 } from '../spec';

/** Evidence is always from this version and seed, including a stored world. */
export async function actionEvidence(spec: GameSpecV1, seed: number, publishedWorld?: ArcadeWorld): Promise<readonly ActionWitness[]> {
  await preloadPhysics(spec, loadRapier);
  if (publishedWorld !== undefined && worldHasPhysics(publishedWorld)) await loadRapier();
  if (spec.control === undefined || spec.control === 'tap_go') return [];
  const made = publishedWorld === undefined ? arcadeWorldOf(spec, seed) : { ok: true as const, world: publishedWorld, roleBindings: bindRoles(spec, publishedWorld) };
  return made.ok ? verifyArcade(made.world, undefined, made.roleBindings).witnesses : [];
}

export const missingActions = (intent: Intent, witnesses: readonly ActionWitness[]): readonly IntentTriple[] =>
  essentialTriples(intent).filter(triple => !witnesses.some(witness => matchesWitness(triple, witness)));

/** An already missing action is not a regression, but one newly lost is. */
export const lostActions = (intent: Intent, before: readonly ActionWitness[], after: readonly ActionWitness[]): readonly IntentTriple[] =>
  essentialTriples(intent).filter(triple => before.some(witness => matchesWitness(triple, witness)) && !after.some(witness => matchesWitness(triple, witness)));
