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
  // P54C T11: vstup slučování (tah posouvá dávkovač, puštění prstu pustí předmět) si zapíná scéna sama.
  merge: { scene: 'merge', input: 'merge' },
  push: { scene: 'push', input: 'arena' },
  // P66 T2: kostry nových žánrů, scény `genres/<žánr>/` (zatím jen podlaha). Pohyb po ploše bere joystick arény;
  // třídění a šipky klepnutím přes vstup pruhů – sloupec je fronta, buňku mřížky nese osa (`cellAxisAt`), takže
  // záznam, ovládání VR ani `InputEvent` nový vstup nepotřebují.
  survivor: { scene: 'survivor', input: 'arena' },
  hole: { scene: 'hole', input: 'arena' },
  steal: { scene: 'steal', input: 'arena' },
  sort: { scene: 'sort', input: 'lanes' },
  arrows: { scene: 'arrows', input: 'lanes' },
} as const;
export type Stage = (typeof STAGES)[keyof typeof STAGES];
export function stageOf(control: string): Stage | null {
  return Object.hasOwn(STAGES, control) ? STAGES[control as keyof typeof STAGES] : null;
}
