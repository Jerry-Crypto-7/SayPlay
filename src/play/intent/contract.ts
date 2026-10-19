/**
 * Smlouva záměru (P41 T1): co věta chce, nezávisle na výběru žánru.
 *
 * Věta se rozpadne na položky aktér – sloveso – předmět, každá na jedné ose:
 * - **pohyb** (`MOVES`) – jak se hrdina hýbe: běží, skáče, řídí, plave, plíží se, kope míč;
 * - **akce** (`ACTIONS`) – co hrdina dělá s věcmi: střílí, hází, bije se, sbírá, rozsvěcí;
 * - **cíl** (`OBJECTIVES`) – čím se vyhrává: závod, dojít, sebrat, přežít, utéct, porazit;
 * - **hrozba** (`THREATS`) – co jde proti hrdinovi: honič, hlídka, nebezpečí, překážka, soupeř.
 *
 * Co věta říká a slovník nezná, je položka osy `unknown` – ne ticho. Skladatel (P41 T9)
 * z položek vybere nejbližší živou sestavu a co nesestaví, vrátí jako nesplněné; ruční štítky
 * sady `evals/play/p41/sentences.json` píšou trojice stejným slovníkem.
 */

/** Jak se hrdina hýbe. `roam` = volný pohyb po aréně shora (dnešní `move_free`). */
export const MOVES = ['run', 'jump', 'flap', 'drive', 'roam', 'glide', 'walk', 'ball'] as const;
export type MoveId = (typeof MOVES)[number];

/** Co hrdina dělá s věcí. `interact` = dojít k věci a něco s ní udělat (rozsvítit, osvobodit, zmáčknout). */
export const ACTIONS = ['shoot', 'throw', 'fight', 'collect', 'deliver', 'interact', 'stack', 'time', 'beat', 'duel', 'kick'] as const;
export type ActionId = (typeof ACTIONS)[number];

/** Čím se vyhrává. `race` = dojet první před soupeři, `reach` = dojít do cíle, `catch` = dohonit předmět. */
export const OBJECTIVES = ['race', 'reach', 'collect', 'survive', 'escape', 'defeat', 'catch', 'score', 'land', 'build'] as const;
export type ObjectiveId = (typeof OBJECTIVES)[number];

/**
 * Kusy os nových žánrů P54C (T4). Zná je zatím jen recept (`compose/recipe.ts`), aby buňky `staged` měly tvar:
 * věta je nevyčte (`extract.ts`), slovník je nekotví (`vocab/anchors.ts`) a podnět akce je nemá. Přidají se
 * do `MOVES` / `ACTIONS` / `OBJECTIVES`, až je klasifikátor (T13) začne číst.
 * - pohyb: `lanes` = přeskok mezi pěti pruhy, `hop` = skok po polích, `crowd` = dav dvěma pruhy, `drop` = dávkovač nad nádobou;
 * - akce: `whack` = úder do vyskočeného cíle, `slice` = švih přes letící věci, `merge` = sloučit dvě stejné, `push` = vytlačit soupeře;
 * - cíl: `defend` = nepustit vlny k hradu.
 */
export const GENRE_MOVES = ['lanes', 'hop', 'crowd', 'drop'] as const;
export const GENRE_ACTIONS = ['whack', 'slice', 'merge', 'push'] as const;
export const GENRE_OBJECTIVES = ['defend'] as const;

/** Co jde proti hrdinovi. `guard` = hlídka, která chytí, když vidí; `rival` = soupeř, který závodí nebo hraje proti. */
export const THREATS = ['chaser', 'guard', 'hazard', 'obstacle', 'rival'] as const;
export type ThreatId = (typeof THREATS)[number];

export const INTENT_AXES = ['move', 'action', 'objective', 'threat', 'unknown'] as const;
export type IntentAxis = (typeof INTENT_AXES)[number];

/** Kanonické sloveso položky podle osy; u `unknown` základní tvar slovesa z věty („knit“). */
export type IntentVerb<A extends IntentAxis = IntentAxis> = A extends 'move'
  ? MoveId
  : A extends 'action'
    ? ActionId
    : A extends 'objective'
      ? ObjectiveId
      : A extends 'threat'
        ? ThreatId
        : string;

/** Aktér, když věta nikoho nejmenuje („game with shooting“ bez hrdiny). */
export const HERO = 'hero';

export interface IntentAction<A extends IntentAxis = IntentAxis> {
  /** Kdo to dělá – jednotné číslo hlavního podstatného jména („car“, „dog“), nebo `HERO`. */
  readonly actor: string;
  /** Kanonický kus na ose (`drive`, `shoot`, `race`, `chaser`); u `unknown` sloveso z věty. */
  readonly verb: IntentVerb<A>;
  /** Komu nebo čemu – jednotné číslo („zombie“, „cat“); `null`, když věta předmět neříká. */
  readonly object: string | null;
  readonly axis: A;
  /** Podstatná položka: bez ní věta není splněná. Doprovodné („colorful“, kulisa) nejsou. */
  readonly essential: boolean;
  /** Slovo z věty, které položku neslo („racing“, „chases“) – pro přiznání a ladění. */
  readonly said: string;
  /** Sloveso mimo ruční tabulku, které tabulka P44C (`vocab/`) přiblížila na tuhle osu – hra ho přizná. */
  readonly mapped?: true;
}

export interface Intent {
  readonly sentence: string;
  /** Hrdina věty – jednotné číslo („car“, „fox“); `null`, když ho věta nejmenuje. */
  readonly hero: string | null;
  /** Prostředí z věty („city“, „ocean“, „space“); `null`, když ho neříká. */
  readonly setting: string | null;
  /** Položky v pořadí věty, bez vyřazených záporem. */
  readonly items: readonly IntentAction[];
  /** Kanonické kusy, které věta záporem vylučuje („without guns“ → `shoot`). */
  readonly negated: readonly string[];
  /** Počty z věty („3 lives“, „10 coins“). */
  readonly counts: readonly { readonly count: number; readonly noun: string }[];
}

/** Trojice, kterou musí hra splnit – tvar ručních štítků sady P41 i svědků (T4). */
export interface IntentTriple {
  readonly actor: string;
  readonly verb: string;
  readonly object: string | null;
}

const onAxis =
  <A extends IntentAxis>(axis: A) =>
  (intent: Pick<Intent, 'items'>): readonly IntentAction<A>[] =>
    intent.items.filter((item): item is IntentAction<A> => item.axis === axis);

export const movesOf = onAxis('move');
export const actionsOf = onAxis('action');
export const objectivesOf = onAxis('objective');
export const threatsOf = onAxis('threat');
export const unknownOf = onAxis('unknown');

/** Podstatné trojice záměru – co musí mít svědka, nebo být přiznané jako nesplněné. */
export const essentialTriples = (intent: Pick<Intent, 'items'>): readonly IntentTriple[] =>
  intent.items.filter((item) => item.essential).map(({ actor, verb, object }) => ({ actor, verb, object }));
