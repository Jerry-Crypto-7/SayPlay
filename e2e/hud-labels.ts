/**
 * Uzavřený anglický seznam popisků počítadel HUD (`data-testid="hud-counter-…"`).
 * Nový popisek se sem dopisuje, nedetekuje – proč, je u `expectEnglishCounters`
 * v `interface-language.spec.ts`. `ammo` přidal doplněk `+shoot` (P26D T7),
 * `collected` nese i počítadlo doplňku `+collect`. Pilulka postupu HUD kitu
 * (P34 T5) přidala `shots` (střelba a hod), `lives` (životy) a `defeated`
 * (cíl mřížky „poraz“).
 */
export const HUD_COUNTER_LABELS: readonly string[] = ['collected', 'gate', 'placed', 'mistakes', 'tools', 'step', 'ammo', 'shots', 'lives', 'defeated'];
