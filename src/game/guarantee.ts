/**
 * Věta dovnitř, svět ven — vždycky (P11 T20).
 *
 * ## Co se tu slibuje
 *
 * `guaranteeWorld()` vrátí spustitelný svět pro **každý** řetězec, včetně
 * prázdného, nesmyslného, protikladného a cizojazyčného. Nevrací `null` a
 * nevyhazuje výjimku na vstup — to je celý ten slib a měří ho
 * `evals/measure-hostile.ts` nad 70 nepřátelskými větami zmrazené sady.
 *
 * ## Co se tu NEslibuje, a proč je to napsané zvlášť
 *
 * Že tomu systém rozuměl. Náhradní místnost je náhrada a nese to v sobě:
 * `kind: 'seed'` plus `fault` s důvodem, proč z věty svět nevznikl. Kdyby se
 * vracela beze stopy, produkt by o větě „asdfghjkl" tvrdil, že jí postavil svět
 * — a nikdo by to nepoznal, protože scéna by vypadala v pořádku. Tichá náhrada
 * je horší vada než prázdná scéna: prázdná scéna je aspoň vidět.
 *
 * `fault` proto **není nikdy prázdný u `seed` a je vždy `null` u `shape`**.
 * Drží to test vedle a čte to report měření.
 *
 * ## Proč se svět staví, a ne jen vyrábí emise
 *
 * „Scéna není prázdná" je tvrzení o **postaveném světě**, ne o JSONu. Emise,
 * kterou `buildRuntimeWorld` odmítne, by prošla každou kontrolou nad svým
 * vlastním tvarem a plátno by po ní zůstalo prázdné. Rozpoznaný tvar se tu
 * proto snižuje týmž vstupním bodem, jakým prochází produkční certifikace, a
 * teprve když z něj svět doopravdy stojí, vydá se jako `shape`.
 *
 * ## Na `src/fallback/**` se tu nesahá
 *
 * Záložní větev je architektonicky nezávislá (P2 T204, hlídá
 * `npm run prove:fallback`) a náhradní místnost je něco jiného: tři ručně
 * napsané archetypy fallbacku jsou samostatná větev produktu, ke které se vede
 * odkaz, kdežto tohle je jedna místnost uvnitř hlavní větve. Import odsud by
 * ty dvě věci slil dohromady a shodil ten důkaz.
 */

import { buildRuntimeWorld } from '@/ir/build';
import type { Recognizer } from '@/model/local/emit';
import { recognize as recognizeShape, seedEmission, shapeIdFor } from '@/model/local/shapes';
import type { WorldDocRuntime } from '@/sim/interpreter';

/** Odkud svět přišel. `shape` = z věty, `seed` = náhradní místnost. */
export type WorldOrigin = 'shape' | 'seed';

export interface GuaranteedWorld {
  readonly kind: WorldOrigin;
  /** Který tvar větu obsloužil; `null` u náhradní místnosti. */
  readonly shapeId: string | null;
  /** Emise tak, jak se z ní stavělo. Pro panel překladu — je vidět, co se hraje. */
  readonly emission: unknown;
  readonly world: WorldDocRuntime;
  /**
   * Proč z věty svět nevznikl. `null` právě tehdy, když `kind === 'shape'`.
   * Není to hláška pro uživatele, je to důvod k pojmenování — report ho počítá
   * do histogramu a produkt z něj může postavit větu, kterou uživatel přečte.
   */
  readonly fault: string | null;
}

/** Vada, kterou nese `seed`. Řetězec ve tvaru `KÓD` nebo `KÓD: detail`. */
type Fault = string;

function describe(thrown: unknown): string {
  return thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
}

/**
 * Emise na svět, nebo vada.
 *
 * Prázdná scéna se odmítá **tady**, ne až v měření: svět bez jediné entity je
 * pro diváka totéž co žádný svět, takže ho nemá smysl vydávat jako odpověď na
 * větu, když vedle leží místnost, ve které je co dělat.
 */
function raise(emission: unknown): { readonly world: WorldDocRuntime } | { readonly fault: Fault } {
  const sim = (emission as { sim?: unknown } | null)?.sim;
  if (sim === undefined || sim === null) return { fault: 'NO_SIM' };

  const built = buildRuntimeWorld(sim);
  if (!built.ok) return { fault: `${built.reason}: ${built.issues.join('; ')}` };
  if (built.world.ir.entities.length === 0) return { fault: 'EMPTY_SCENE' };
  return { world: built.world };
}

/** Svět z věty, nebo vada, která tomu zabránila. */
function fromSentence(sentence: string, recognize: Recognizer): GuaranteedWorld | Fault {
  let emission: unknown;
  try {
    emission = recognize(sentence);
  } catch (thrown) {
    // Rozpoznávač je řada regulárních výrazů nad cizím textem. Pád v něm je
    // vada rozpoznávače, ne věty — ale uživatel za ni nesmí zaplatit prázdnou
    // scénou, takže se z něj tady stává obyčejná vada s důvodem.
    return `RECOGNIZER_THREW: ${describe(thrown)}`;
  }
  if (emission === null) return 'NO_SHAPE';

  const raised = raise(emission);
  if ('fault' in raised) return raised.fault;
  return { kind: 'shape', shapeId: shapeIdFor(sentence), emission, world: raised.world, fault: null };
}

/**
 * Svět pro libovolnou větu. Nikdy `null`.
 *
 * Vyhodí výjimku jen tehdy, když se nepostaví **náhradní místnost** — a to není
 * odpověď na vstup, je to rozbité sestavení: `seedEmission()` je konstanta,
 * takže když nestojí ona, nestojí nic. Tichá náhrada za náhradu by tu vadu
 * schovala do posledního místa, kde by ji někdo hledal.
 *
 * `recognize` se dá podstrčit ze **stejného důvodu jako v `emitLocally`**: bez
 * něj se cesty, které se otevřou až když je něco rozbité — nerozpoznatelná
 * emise, pád uvnitř rozpoznávače — nedají vyzkoušet jinak než tím, že se
 * rozbije produkční rozpoznávač. Právě ty cesty ale nesou celý slib téhle
 * funkce, takže se testovat musí.
 */
export function guaranteeWorld(sentence: string, recognize: Recognizer = recognizeShape): GuaranteedWorld {
  const attempted = fromSentence(sentence, recognize);
  if (typeof attempted !== 'string') return attempted;

  const emission = seedEmission();
  const raised = raise(emission);
  if ('fault' in raised)
    throw new Error(`náhradní místnost se nepostavila (${raised.fault}) — vada sestavení, ne věty`);

  return { kind: 'seed', shapeId: null, emission, world: raised.world, fault: attempted };
}
