import { readCountedNouns } from '../src/play/draft/lexicon';

/**
 * Uzavřený anglický seznam popisků počítadel HUD (`data-testid="hud-counter-…"`).
 * Nový popisek se sem dopisuje, nedetekuje – proč, je u `expectEnglishCounters`
 * v `interface-language.spec.ts`. `ammo` přidal doplněk `+shoot` (P26D T7),
 * `collected` nese i počítadlo doplňku `+collect`. Pilulka postupu HUD kitu
 * (P34 T5) přidala `shots` (střelba a hod), `lives` (životy) a `defeated`
 * (cíl mřížky „poraz“). `best` je rekord k překonání (P36B T4).
 * `powerup` a `combo` jsou odznak power-upu a násobič komba (P46C T5, `PowerupBadge.tsx`).
 * `round` je kolo řetězu mikroher `2/5` (P56C T11, `ChainPlay.tsx`), `ghost` kolo ducha, když je v jiném (T12).
 * `rare` a `epic` jsou pilulka nálezu háčků „2 rare“ (P66 T4, `arcade/hooks/RarityToast.tsx`).
 * `m`, `hits`, `notes` a `rounds` nese postup v řádku cíle „42 m / 220 m“, „3 notes“ (P70C T2, `goalProgressOf`,
 * `data-testid="play-goal-progress"`); hlídá je `p70c-start-card.spec.ts`.
 * `explored` je pilulka klikací simulace „explored 3/5“ (P83C T7, `finish_collected.noun` v `pieces/orrery.ts`).
 */
export const HUD_COUNTER_LABELS: readonly string[] = ['collected', 'gate', 'placed', 'mistakes', 'tools', 'step', 'ammo', 'shots', 'lives', 'defeated', 'best', 'dare', 'powerup', 'combo', 'round', 'ghost', 'rare', 'epic', 'served', 'coins', 'smash', 'air', 'strokes', 'par', 'm', 'hits', 'notes', 'rounds', 'explored'];

/**
 * Popisky, které smí ukázat hra z věty `sentence`: uzavřený seznam a podstatná jména, která věta počítá
 * (P61 T5: „collect three keys“ → `keys 0/3`). Ta píše věta, ne autor rozhraní – věty jsou anglicky.
 */
export function counterLabelsFor(sentence: string): readonly string[] {
  return [...HUD_COUNTER_LABELS, ...readCountedNouns(sentence).map((entry) => entry.noun)];
}
