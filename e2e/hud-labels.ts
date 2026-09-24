/**
 * Uzavřený anglický seznam popisků počítadel HUD (`data-testid="hud-counter-…"`).
 * Nový popisek se sem dopisuje, nedetekuje – proč, je u `expectEnglishCounters`
 * v `interface-language.spec.ts`. `ammo` přidal doplněk `+shoot` (P26D T7),
 * `collected` nese i počítadlo doplňku `+collect`.
 */
export const HUD_COUNTER_LABELS: readonly string[] = ['collected', 'gate', 'placed', 'mistakes', 'tools', 'step', 'ammo'];
