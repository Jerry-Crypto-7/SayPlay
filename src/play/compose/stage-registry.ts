/** Browser-independent routing contract. ArcadeStage consumes these same keys. */
export const STAGES = {
  glide: { scene: 'world', input: 'glide' },
  walker: { scene: 'world', input: 'walker' },
  ball: { scene: 'world', input: 'ball' },
  runner: { scene: 'runner', input: 'runner' },
  platform: { scene: 'platform', input: 'platform' },
  flap: { scene: 'world', input: 'flap' },
  steer: { scene: 'world', input: 'steer' },
  move_free: { scene: 'arena', input: 'arena' },
  fight: { scene: 'arena', input: 'arena' },
  shooter: { scene: 'world', input: 'shooter-rig' },
  throw: { scene: 'world', input: 'throw-rig' },
  timing: { scene: 'timing', input: 'tap' },
  rhythm: { scene: 'rhythm', input: 'tap' },
  duel: { scene: 'duel', input: 'duel' },
  // P54C T4: ovládání nových žánrů. Scénu `lanes` kreslí `genres/lanes/LaneScene`; scény hop, crowd, merge a push
  // přidá úloha žánru – do té doby je nevybere žádná živá buňka.
  lanes: { scene: 'lanes', input: 'lanes' },
  hop: { scene: 'hop', input: 'hop' },
  crowd: { scene: 'crowd', input: 'lanes' },
  merge: { scene: 'merge', input: 'lanes' },
  push: { scene: 'push', input: 'arena' },
} as const;
export type Stage = (typeof STAGES)[keyof typeof STAGES];
export function stageOf(control: string): Stage | null {
  return Object.hasOwn(STAGES, control) ? STAGES[control as keyof typeof STAGES] : null;
}
