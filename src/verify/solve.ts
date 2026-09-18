/**
 * Hledač svědka — **systém si vítěznou cestu dohledá sám**.
 *
 * ## Proč tenhle modul vůbec vznikl
 *
 * Svědek není obsah světa, je to **důkaz, že se svět dá dohrát**. Model do téhle
 * chvíle musel psát obojí, a naměřeně to nezvládá: v zaznamenaných emisích
 * (`evals/local-model/grammar-raw.json`) píše do `witness.ops` efekty
 * (`setState`, `addCounter`, `setFlag`), jména událostí (`onCollide`) i jména
 * vlastních pravidel (`openRoof`) — tedy cokoli, jen ne vstupy hráče. Živé běhy
 * brány vlny to potvrdily z druhé strany: tři ze čtyř odmítnutí 26. 8. 2026 byla
 * `witness/NO_WIN` nebo `witness/STEP_UNREACHABLE` nad světy, jejichž pravidla
 * byla v pořádku.
 *
 * Dělba práce je proto nově tahle: **model píše význam, systém dokazuje
 * dohratelnost.** Nalezená stopa se pak ověřuje **týmž** `verifyWitness`, jakým
 * by se ověřovala stopa od modelu — hledač si nekupuje žádnou úlevu a garance
 * „nic vadného neprojde" se nehne. Svět, který se vyhrát nedá, hledač nenajde a
 * odmítnutí zůstane.
 *
 * ## Abeceda vstupů je odvozená, ne vymyšlená
 *
 * `step()` z jednoho vstupu vyrobí přesně jeden fakt `acted(actor, actionId,
 * target)` (`src/sim/interpreter.ts:850`). Vstup, na který se neptá žádný
 * predikát, tedy **nemůže změnit nic** — a predikáty, které se na `acted`
 * ptají, jsou právě ty pojmenované `p.onAction.<actor>.<actionId>.<target>`
 * (`src/ir/lower.ts:157`). Abeceda hledání je proto přesně jejich množina:
 * úplná (nic jiného nefunguje) a nejtěsnější možná (nic zbytečného v ní není).
 *
 * ## Prohledávání
 *
 * Do šířky, s dedukcí podle **stavového hashe** — což je táž FNV-1a, na které
 * stojí replay (`src/sim/hash.ts`), takže dvě cesty do téhož stavu se sloučí
 * bez druhého kritéria rovnosti. Rozpočet je v **uzlech, ne v čase**: hledání
 * musí dát v prohlížeči i v Node tutéž odpověď, a to hodiny neumějí.
 */

import { hashHex } from '../sim/hash';
import {
  createRuntime,
  entityPlacements,
  step,
  type Runtime,
  type TraceInput,
  type WorldDocRuntime,
} from '../sim/interpreter';

import { DEFAULT_REQUEST, resolvePolicy } from './tiers';
import { verifyWitness, type VerifiableWorld } from './witness';

/** Kanonický zástupce za nepřítomný cíl — týž, jaký používá `step()` i verifikátor. */
const NO_TARGET = 'none';

/** Jeden vstup abecedy: co hráč zmáčkne a na co. */
export interface InputMove {
  readonly actionId: string;
  /** `undefined` = akce bez cíle. */
  readonly target: string | undefined;
}

export interface SolveOptions {
  /**
   * Kolik replayů se smí udělat. **Rozpočet v uzlech, ne v milisekundách** —
   * je to jediná mez, která dá v prohlížeči i v Node tutéž odpověď.
   */
  readonly maxNodes: number;
  /**
   * Kolik tiků smí hledání celkem odsimulovat, přes všechny replaye.
   *
   * `maxNodes` sám nestačí: replay jde od nuly, takže cena uzlu roste s hloubkou
   * i s velikostí světa. Naměřeno 16. 9. 2026 (P19 R6): svět pokladny s
   * nevyhratelnými pravidly vyčerpal 20 000 replayů za 127–167 s a nic nenašel,
   * přičemž nejdražší úspěšné hledání v archivu stálo 171 replayů.
   */
  readonly maxTicks: number;
  /** Nejvyšší počet vstupů v hledané stopě. */
  readonly maxDepth: number;
  /**
   * Kolik tiků dostane svět po každém vstupu, než přijde další.
   *
   * Musí pokrýt přechod přes mřížku, protože `settle` posouvá entitu o jednu
   * buňku za tik (`src/sim/interpreter.ts:790`) — kratší okno by vstup doručilo
   * dřív, než hráč dojde, a hledač by prohlásil za neřešitelný svět, který
   * řešitelný je.
   */
  readonly settleTicks: number;
  /**
   * Místo, kterým musí nalezená cesta hráče provést. **Nepřítomné = dnešní
   * chování**: hledá se kterákoli vítězná cesta a nic víc.
   *
   * Je to zúžení cíle, ne jeho výměna. Certifikát vydává `verifyWitness` a ten
   * certifikuje **jen vítěznou stopu** — cesta „jen k X" tedy žádný certifikát
   * dostat nemůže a průvodce, který by ji vydával, by tvrdil něco, co systém
   * neověřil. Cíl s hodnotou proto znamená „vyhraj a přitom projdi tudy".
   *
   * **Abeceda vstupů se tím nemění.** Hledá se pořád jen mezi vstupy, na které
   * se v tom světě ptá nějaké pravidlo; přibyla podmínka přijetí, ne tah.
   */
  readonly goal?: string;
}

/**
 * Kde ve světě cíl hledání leží.
 *
 * Jmenné prostory se **řadí, nesčítají**, a to v tomtéž pořadí jako ve
 * verifikátoru (`src/verify/witness.ts`): jméno deklarované entity je entita,
 * soket je náhradník pro jména, která entitou nejsou, a zóna až po něm. Druhé
 * pořadí by znamenalo, že soket pojmenovaný jako entita zastíní entitu — tedy
 * dvě odpovědi na otázku, co je to „gate".
 */
export type GoalPlace =
  | { readonly kind: 'entity'; readonly stableId: string }
  | { readonly kind: 'cell'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'zone';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };

/** `null` = takové místo ve světě není. Volající to smí odlišit od „nenašel jsem cestu". */
export function locateGoal(world: WorldDocRuntime, target: string): GoalPlace | null {
  if (world.ir.entities.some((entity) => entity.stableId === target)) return { kind: 'entity', stableId: target };
  const socket = world.space.sockets[target];
  if (socket !== undefined) return { kind: 'cell', x: socket[0], y: socket[1] };
  const zone = world.space.zones[target];
  if (zone !== undefined) return { kind: 'zone', x: zone[0], y: zone[1], width: zone[2], height: zone[3] };
  return null;
}

/** Cíl už převedený na místo, plus kdo k němu má dojít. */
interface GoalWatch {
  readonly actor: string;
  readonly place: GoalPlace;
}

/**
 * Stojí jednající entita v tuhle chvíli na cíli?
 *
 * Čte se **poloha ve stavu**, ne deklarovaný soket: entity se pohybují, takže
 * deklarace by odpovídala na otázku, kde cíl býval. Despawnutá entita cílem
 * není — stojí po ní ve slotech jen stará souřadnice.
 */
function standsOnGoal(runtime: Runtime, watch: GoalWatch): boolean {
  const placements = entityPlacements(runtime);
  const here = placements.find((entry) => entry.stableId === watch.actor);
  if (here === undefined || !here.active) return false;

  const place = watch.place;
  switch (place.kind) {
    case 'entity': {
      const there = placements.find((entry) => entry.stableId === place.stableId);
      return there !== undefined && there.active && there.x === here.x && there.y === here.y;
    }
    case 'cell':
      return here.x === place.x && here.y === place.y;
    case 'zone':
      return (
        here.x >= place.x &&
        here.y >= place.y &&
        here.x < place.x + place.width &&
        here.y < place.y + place.height
      );
    default: {
      const exhaustive: never = place;
      return exhaustive;
    }
  }
}

export interface SolveResult {
  readonly ops: readonly TraceInput[];
  /** Kolik replayů to stálo. Jde do stopy, ať je vidět, co hledání dělalo. */
  readonly nodes: number;
  /** Tik, ve kterém nalezená stopa vyhrála. */
  readonly wonAtTick: number;
}

/**
 * Vstupy, na které se v tomhle světě vůbec někdo ptá.
 *
 * Jména se **neparsují dělením na tečky** — stableId s tečkou by rozpad
 * rozhodil a hledač by tiše ztratil část abecedy. Místo toho se zkouší
 * konkrétní známé konce: cíl je vždycky deklarovaná entita nebo kanonický
 * zástupce `none`, takže se dá poznat podle přípony a `actionId` je zbytek.
 */
export function inputAlphabet(world: WorldDocRuntime, actor: string): readonly InputMove[] {
  const prefix = `p.onAction.${actor}.`;
  const targets = [...world.ir.entities.map((entity) => entity.stableId), NO_TARGET];
  const found = new Map<string, InputMove>();

  for (const predicate of world.ir.predicates) {
    const id = predicate.predicateId;
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    for (const target of targets) {
      if (rest !== target && !rest.endsWith(`.${target}`)) continue;
      const actionId = rest === target ? '' : rest.slice(0, rest.length - target.length - 1);
      if (actionId === '') continue;
      const move: InputMove = { actionId, target: target === NO_TARGET ? undefined : target };
      found.set(`${actionId}\u001f${target}`, move);
    }
  }

  // Setříděné, protože pořadí rozhoduje o tom, kterou z několika vítězných cest
  // hledač najde první – a ta se hashuje do certifikátu. Proto porovnání po
  // kódových jednotkách, ne `localeCompare`: ten čte výchozí locale a verzi ICU
  // hostitele, takže by tentýž svět mohl v prohlížeči a v Node vydat jiný
  // certifikát. Stejné pravidlo drží `src/ir/worlddoc.ts`.
  return [...found.values()].sort((a, b) => {
    if (a.actionId !== b.actionId) return a.actionId < b.actionId ? -1 : 1;
    const left = a.target ?? '';
    const right = b.target ?? '';
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Kdo v tomhle světě jedná. `onAction` bez actora nemá kdo vyvolat. */
export function actorOf(world: WorldDocRuntime): string | null {
  const declared = world.ir.entities.find((entity) => entity.role === 'actor');
  return declared?.stableId ?? world.ir.entities[0]?.stableId ?? null;
}

interface Replay {
  readonly runState: string;
  readonly hash: string;
  readonly tick: number;
  /**
   * Prošla stopa cílem hledání? Bez cíle je to `true` — hledání tak zůstává
   * bit po bitu tím, čím bylo.
   *
   * Měří se **po každém tiku**, ne až na konci: hráč cílem projde a jde dál,
   * takže pohled jen na poslední stav by cestu prohlásil za neexistující.
   */
  readonly reached: boolean;
}

/**
 * Přehraje stopu od nuly a doběhne `untilTick`.
 *
 * Od nuly schválně: `Runtime` je měnitelný a jeho `previous` observace nese
 * mapy, takže snímkování by znamenalo druhou definici toho, co je stav — a ta
 * by se s `hashHex(runtime.state)` uměla rozejít. Světy jsou malé, replay je
 * levný, a takhle je jistota, že hledač simuluje přesně to, co pak ověří
 * verifikátor.
 */
function replay(
  world: VerifiableWorld,
  trace: readonly TraceInput[],
  untilTick: number,
  watch: GoalWatch | null,
): Replay {
  const runtime = createRuntime(world);
  let cursor = 0;
  let reached = watch === null || standsOnGoal(runtime, watch);
  for (let tick = 0; tick <= untilTick && runtime.runState === 'running'; tick += 1) {
    const inputs: TraceInput[] = [];
    while (cursor < trace.length && trace[cursor].tick === tick) {
      inputs.push(trace[cursor]);
      cursor += 1;
    }
    step(runtime, inputs);
    if (!reached && watch !== null && standsOnGoal(runtime, watch)) reached = true;
  }
  return { runState: runtime.runState, hash: hashHex(runtime.state), tick: runtime.tick, reached };
}

/**
 * Najde stopu, kterou `verifyWitness` certifikuje, nebo `null`.
 *
 * **Prázdná stopa se nevrací nikdy.** Svět, který vyhraje bez jediného vstupu,
 * je hratelný leda formálně; kdyby ho hledač „opravil" na certifikovaný,
 * posunul by laťku dolů místo nahoru. Takový svět tedy zůstane odmítnutý s
 * vlastním důvodem.
 */
export function solveWitness(world: VerifiableWorld, options: SolveOptions): SolveResult | null {
  return solveWitnessDetailed(world, options).result;
}

export interface SolveDiagnostic {
  readonly status: 'solved' | 'search-exhausted' | 'budget-exhausted' | 'ineligible';
  readonly result: SolveResult | null;
  readonly nodes: number;
  /** Replay ticks, including the independent certification replay of a winning trace. */
  readonly ticks: number;
}

/** Bounded search failure is not a proof that the world is unwinnable. */
export function solveWitnessDetailed(world: VerifiableWorld, options: SolveOptions): SolveDiagnostic {
  let nodes = 0, ticks = 0;
  let capped = false;
  const done = (status: SolveDiagnostic['status'], result: SolveResult | null = null): SolveDiagnostic => ({status,result,nodes,ticks});
  // Táž politika, jakou si vezme verifikátor — ne vlastní. Kdyby si hledač
  // horizont počítal sám, uměl by najít stopu, kterou pak verifikátor odmítne
  // jako `NO_FIT`, a rozdíl by se projevil až u porotce.
  const policy = resolvePolicy(world.certification ?? DEFAULT_REQUEST);
  if (policy === null) return done('ineligible');

  const actor = actorOf(world);
  if (actor === null) return done('ineligible');

  const alphabet = inputAlphabet(world, actor);
  if (alphabet.length === 0) return done('ineligible');

  // Cíl, který ve světě není, není prohledatelný. Je to táž třída jako svět bez
  // jednající entity, proto týž status — kdo chce „to tu není" odlišit od
  // „nenašel jsem cestu", zeptá se `locateGoal` dřív, než hledání vůbec spustí.
  let watch: GoalWatch | null = null;
  if (options.goal !== undefined) {
    const place = locateGoal(world, options.goal);
    if (place === null) return done('ineligible');
    watch = { actor, place };
  }

  // Svět, který vyhraje sám, se nedokazuje — hledač by mu vydal certifikát za
  // to, že hráč není potřeba. Laťka se tím nesmí snížit: takový svět zůstane
  // odmítnutý svým vlastním důvodem, přesně jako doteď.
  const alone = replay(world, [], Math.min(policy.maxHorizonTicks, Math.max(0, options.maxTicks) - 1), null);
  ticks += alone.tick;
  if (alone.runState === 'won') return done('ineligible');
  if (ticks >= options.maxTicks) return done('budget-exhausted');

  const depthCap = Math.min(options.maxDepth, policy.maxInputs);
  const settle = Math.max(1, options.settleTicks);
  const actions = alphabet.filter(move => move.actionId !== 'moveTo');
  const navigation = alphabet.filter(move => move.actionId === 'moveTo');

  // Reserve within the existing total, never reset the budget after the coarse BFS.
  // Existing successful ordering remains unchanged within this primary allocation.
  const reserve = actions.length > 0 && depthCap > 0 ? Math.floor(options.maxTicks / 4) : 0;
  const primaryTicks = Math.max(ticks, options.maxTicks - reserve);
  const input = (move: InputMove, tick: number): TraceInput => move.target === undefined
    ? {tick,actor,actionId:move.actionId} : {tick,actor,actionId:move.actionId,target:move.target};
  const attempt = (candidate: readonly TraceInput[], until: number, limit: number): Replay | null => {
    if (nodes >= options.maxNodes || ticks >= limit) { capped = true; return null; }
    nodes += 1;
    const last = Math.min(until, policy.maxHorizonTicks - 1, limit - ticks - 1);
    const outcome = replay(world, candidate, last, watch);
    ticks += outcome.tick;
    if (outcome.runState === 'running' && last < Math.min(until, policy.maxHorizonTicks - 1)) capped = true;
    return outcome;
  };
  const certify = (candidate: readonly TraceInput[], outcome: Replay): SolveDiagnostic | null => {
    // `reached` je bez cíle vždycky `true`, takže tahle podmínka bez parametru
    // nic nefiltruje. S cílem je to jediné místo, kde se zúžení projeví.
    if (outcome.runState !== 'won' || !outcome.reached) return null;
    // The verifier follows the same deterministic trace and cannot run beyond
    // its observed win tick. Charge that replay too, before executing it.
    if (ticks + outcome.tick > options.maxTicks) return done('budget-exhausted');
    ticks += outcome.tick;
    const verdict = verifyWitness({...world,trace:candidate},candidate);
    return verdict.verdict === 'CERTIFIED' ? done('solved',{ops:candidate,nodes,wonAtTick:outcome.tick}) : null;
  };
  let frontier: (readonly TraceInput[])[] = [[]];
  const seen = new Set<string>();

  primary: for (let depth = 0; depth < depthCap; depth += 1) {
    const next: (readonly TraceInput[])[] = [];
    for (const trace of frontier) {
      const tick = trace.length * settle;
      if (tick >= policy.maxHorizonTicks) continue;

      for (const move of alphabet) {
        const candidate = [...trace, input(move,tick)];
        const outcome = attempt(candidate,tick+settle,primaryTicks);
        if (!outcome) break primary;

        if (outcome.runState === 'won') {
          // Ověřuje se TÍMTÉŽ verifikátorem, jaký soudí stopu od modelu. Hledač
          // si nesmí vydat vlastní certifikát — pak by existovaly dvě definice
          // toho, co je dohratelné, a rozešly by se.
          const result = certify(candidate,outcome);
          if (result) return result;
          continue;
        }
        if (outcome.runState !== 'running') continue;

        // Dedukce podle stavového hashe: dvě různé cesty do téhož stavu mají
        // odsud tutéž budoucnost, takže druhá z nich je práce navíc.
        if (seen.has(outcome.hash)) continue;
        seen.add(outcome.hash);
        next.push(candidate);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  // Temporal fallback: no invented effects or model witness. Navigation is still
  // the same input alphabet; only the time of a real player action changes.
  // Interleave waiting actions and fine movement/action pairs, so neither family
  // can consume the reserved budget before the other receives any exploration.
  for (let slot = 0; slot < policy.maxHorizonTicks; slot += 1) {
    const delayedTick = slot * settle;
    if (delayedTick >= policy.maxHorizonTicks && slot >= settle) break;
    for (const action of actions) {
      if (depthCap >= 1 && delayedTick < policy.maxHorizonTicks) {
        const candidate = [input(action,delayedTick)];
        const outcome = attempt(candidate,delayedTick+settle,options.maxTicks);
        if (!outcome) return done('budget-exhausted');
        const result = certify(candidate,outcome);
        if (result) return result;
      }
      if (depthCap < 2 || slot === 0 || slot >= settle) continue;
      for (const move of navigation) {
        const candidate = [input(move,0),input(action,slot)];
        const outcome = attempt(candidate,slot+settle,options.maxTicks);
        if (!outcome) return done('budget-exhausted');
        const result = certify(candidate,outcome);
        if (result) return result;
      }
    }
  }
  return done(capped ? 'budget-exhausted' : 'search-exhausted');
}
