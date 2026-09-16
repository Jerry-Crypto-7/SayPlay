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
import { createRuntime, step, type TraceInput, type WorldDocRuntime } from '../sim/interpreter';

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
function replay(world: VerifiableWorld, trace: readonly TraceInput[], untilTick: number): Replay {
  const runtime = createRuntime(world);
  let cursor = 0;
  for (let tick = 0; tick <= untilTick && runtime.runState === 'running'; tick += 1) {
    const inputs: TraceInput[] = [];
    while (cursor < trace.length && trace[cursor].tick === tick) {
      inputs.push(trace[cursor]);
      cursor += 1;
    }
    step(runtime, inputs);
  }
  return { runState: runtime.runState, hash: hashHex(runtime.state), tick: runtime.tick };
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
  // Táž politika, jakou si vezme verifikátor — ne vlastní. Kdyby si hledač
  // horizont počítal sám, uměl by najít stopu, kterou pak verifikátor odmítne
  // jako `NO_FIT`, a rozdíl by se projevil až u porotce.
  const policy = resolvePolicy(world.certification ?? DEFAULT_REQUEST);
  if (policy === null) return null;

  const actor = actorOf(world);
  if (actor === null) return null;

  const alphabet = inputAlphabet(world, actor);
  if (alphabet.length === 0) return null;

  // Svět, který vyhraje sám, se nedokazuje — hledač by mu vydal certifikát za
  // to, že hráč není potřeba. Laťka se tím nesmí snížit: takový svět zůstane
  // odmítnutý svým vlastním důvodem, přesně jako doteď.
  const alone = replay(world, [], policy.maxHorizonTicks);
  if (alone.runState === 'won') return null;

  const depthCap = Math.min(options.maxDepth, policy.maxInputs);
  const settle = Math.max(1, options.settleTicks);

  let nodes = 0;
  let ticks = alone.tick;
  let frontier: (readonly TraceInput[])[] = [[]];
  const seen = new Set<string>();

  for (let depth = 0; depth < depthCap; depth += 1) {
    const next: (readonly TraceInput[])[] = [];
    for (const trace of frontier) {
      const tick = trace.length * settle;
      if (tick >= policy.maxHorizonTicks) continue;

      for (const move of alphabet) {
        if (nodes >= options.maxNodes || ticks >= options.maxTicks) return null;
        const input: TraceInput =
          move.target === undefined
            ? { tick, actor, actionId: move.actionId }
            : { tick, actor, actionId: move.actionId, target: move.target };
        const candidate = [...trace, input];

        nodes += 1;
        const outcome = replay(world, candidate, tick + settle);
        ticks += outcome.tick;

        if (outcome.runState === 'won') {
          // Ověřuje se TÍMTÉŽ verifikátorem, jaký soudí stopu od modelu. Hledač
          // si nesmí vydat vlastní certifikát — pak by existovaly dvě definice
          // toho, co je dohratelné, a rozešly by se.
          const verdict = verifyWitness({ ...world, trace: candidate }, candidate);
          if (verdict.verdict === 'CERTIFIED') return { ops: candidate, nodes, wonAtTick: outcome.tick };
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

  return null;
}
