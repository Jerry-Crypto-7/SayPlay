/**
 * Průvodce — odpověď na otázku „kudy k X" **z pravidel světa, ne z výmyslu**.
 *
 * ## Proč to není generování věty
 *
 * Postava, která na otázku odpoví plynule a nepravdivě, vypadá líp než postava,
 * která poctivě řekne „nevím". To je celý problém: výmysl se pozná jen tím, že
 * se odpověď porovná se světem, a porovnávat ji umí jen něco, co ten svět
 * doopravdy odsimuluje. Průvodce proto **žádnou odpověď nevymýšlí** — nechá
 * hledač najít cestu mezi vstupy, na které se v tom světě ptá nějaké pravidlo,
 * a pak ji dá **témuž `verifyWitness`**, jakým se soudí stopa od modelu. Co
 * neprojde verifikátorem, neodejde ven.
 *
 * ## Tři odpovědi, tři jména
 *
 * Splynutí „nevím" a „nenašel jsem" je jedna z těch nepravd, které jdou napsat
 * jedním řádkem a nikdo si jich nevšimne, protože obě vypadají jako `null`:
 *
 * - `ROUTE` — cesta, kterou verifikátor certifikoval, plus ten certifikát.
 * - `NOT_IN_WORLD` — takový objekt tu není. Odpověď nese **jen slovo, na které
 *   se ptal tazatel**, žádné jméno ze světa: nejbližší existující objekt by byl
 *   přesně ten výmysl, kterému se tenhle modul má vyhnout.
 * - `NO_ROUTE` — objekt tu je, cestu k němu ale hledání v rozpočtu nenašlo.
 *
 * Rozhoduje se tady a **formuluje se jinde** — věta je T13, scéna T14.
 */

import type { TraceInput } from '../sim/interpreter';
import { locateGoal, solveWitnessDetailed, type SolveOptions } from '../verify/solve';
import { verifyWitness, type Certificate, type VerifiableWorld, type VerifyResult } from '../verify/witness';

/** Proč cesta k existujícímu cíli nevznikla. */
export type NoRouteReason =
  /** Došel rozpočet hledání — o světě to nedokazuje nic. */
  | 'BUDGET_EXHAUSTED'
  /** Prohledáno v mezích, žádná certifikovatelná cesta tudy nevede. */
  | 'SEARCH_EXHAUSTED'
  /** V tomhle světě není co prohledávat: nikdo v něm nejedná, nebo vyhraje sám. */
  | 'WORLD_INELIGIBLE'
  /** Hledač cestu vydal, verifikátor ji zamítl. Ven nejde. */
  | 'UNCERTIFIED';

export interface GuidedRoute {
  readonly status: 'ROUTE';
  /** Slovo tazatele. */
  readonly asked: string;
  /** Jméno, které ve světě **doopravdy je**. Jediné jméno, které smí do věty. */
  readonly target: string;
  readonly ops: readonly TraceInput[];
  readonly certificate: Certificate;
}

export interface TargetNotInWorld {
  readonly status: 'NOT_IN_WORLD';
  readonly asked: string;
}

export interface NoRouteFound {
  readonly status: 'NO_ROUTE';
  readonly asked: string;
  readonly target: string;
  readonly reason: NoRouteReason;
}

export type GuideAnswer = GuidedRoute | TargetNotInWorld | NoRouteFound;

/** Rozpočet hledání bez cíle — ten si průvodce dosazuje sám z otázky. */
export type GuideBudget = Omit<SolveOptions, 'goal'>;

/**
 * Brána průvodce: co říká **verifikátor** na navrženou cestu.
 *
 * Svět dostane stopu i jako `trace`, protože přesně tak vypadá dokument, který
 * verifikátor soudí u modelu — průvodce si tím nekupuje žádnou úlevu.
 */
export function certifyRoute(world: VerifiableWorld, ops: readonly TraceInput[]): VerifyResult {
  return verifyWitness({ ...world, trace: ops }, ops);
}

/** Existuje ve světě dosažitelná, certifikovaná cesta k `asked`? */
export function guideRoute(world: VerifiableWorld, asked: string, budget: GuideBudget): GuideAnswer {
  if (locateGoal(world, asked) === null) return { status: 'NOT_IN_WORLD', asked };

  const diagnostic = solveWitnessDetailed(world, { ...budget, goal: asked });
  const refuse = (reason: NoRouteReason): NoRouteFound => ({
    status: 'NO_ROUTE',
    asked,
    target: asked,
    reason,
  });

  if (diagnostic.result === null)
    switch (diagnostic.status) {
      case 'budget-exhausted':
        return refuse('BUDGET_EXHAUSTED');
      case 'ineligible':
        return refuse('WORLD_INELIGIBLE');
      default:
        return refuse('SEARCH_EXHAUSTED');
    }

  // Hledač si certifikát vydává sám, a právě proto se tady ptáme znovu: odpověď
  // ven nese důkaz, ne tvrzení o důkazu.
  const verdict = certifyRoute(world, diagnostic.result.ops);
  if (verdict.verdict !== 'CERTIFIED') return refuse('UNCERTIFIED');

  return { status: 'ROUTE', asked, target: asked, ops: diagnostic.result.ops, certificate: verdict };
}
