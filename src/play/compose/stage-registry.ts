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
  // P68 T1: kostry pěti her P68, scény `genres/<žánr>/` (zatím jen podlaha), vstupy zmrazené v `P68_INPUT`
  // (`genre/p68-contract.ts`). `genre` = vlastní dotykový adaptér hry z `genres/touch-registry.ts`, který volá jen
  // `session.press` / `session.hold` – tvar záznamu se nemění.
  stunt: { scene: 'stunt', input: 'steer' },
  minigolf: { scene: 'minigolf', input: 'throw-rig' },
  railfps: { scene: 'railfps', input: 'genre' },
  buildshift: { scene: 'buildshift', input: 'lanes' },
  drawsave: { scene: 'drawsave', input: 'genre' },
  // P83C: klikací simulace – dotykový adaptér `genres/orrery/OrreryTouch` najde věc pod prstem.
  orrery: { scene: 'orrery', input: 'genre' },
  // P83E: obchod – ťuk na cenovku přes vlastní adaptér `genres/shop/ShopTouch.tsx` (police nesedí na mřížku pruhů).
  shop: { scene: 'shop', input: 'genre' },
} as const;
export type Stage = (typeof STAGES)[keyof typeof STAGES];
export function stageOf(control: string): Stage | null {
  return Object.hasOwn(STAGES, control) ? STAGES[control as keyof typeof STAGES] : null;
}
