import { observePhase, observePhaseAsync, type PhaseObserver } from './phase-observer';
import { WORLDSTREAM_ASSETS } from '@/assets/catalog';
import type { VisualPreview } from '@/worldstream/schema';
/**
 * **Sebeoprava blueprintu (P13 T12): odmítnutí compileru → další pokus.**
 *
 * P12 vlna 2 už jednu takovou smyčku má — `src/model/local/emit.ts` nad
 * světovým grafem. Tenhle soubor **nestaví druhou**: rozvržení opravné zprávy
 * si bere ze společného modulu `local/rejection-prompt.ts` (`repairRequest()`),
 * stejně jako tvar kola, strop a zastavení na nepohnutém odmítnutí. Vlastní je
 * tu jedině **slovník vad**, protože compiler blueprintu odmítá jiným svazkem
 * důvodů než certifikace světa.
 *
 * Co se odtud naopak **nepřebírá, je useknutí ukázky** (`retrySystem()`) —
 * jeho naměřené odůvodnění platí pro okno 4 096 tokenů a na cloudovou cestu
 * se nepřenáší. Celé je to u `buildRepairRequest()` níž.
 *
 * ## Věta, ne kategorie
 *
 * `invalid shape` není zpráva — model z ní nemá co opravit a druhé kolo napíše
 * tutéž vadu znovu. Věta proto vždycky nese **kód a naměřené číslo**, přesně
 * v tvaru, který design book §16 předepisuje do Inspect zásuvky:
 *
 * ```
 * SHAPE_INVALID · shapes[0]: program expands to 512 copies, above maxInstances 256
 * ```
 *
 * Číslo si tenhle modul nevymýšlí. Bere ho z brány, která odmítla — rozpočtové
 * hlášky `validateShapeProgram()` a `validateGeomProgram()` ho nesou samy a
 * `findBlueprintReferenceIssues()` k němu dává adresu. **Kde brána číslo nemá,
 * věta ho nemá taky**; dopsat poměr, který nikdo nezměřil, je přesně ta vada,
 * kterou tenhle projekt zakazuje jinde.
 *
 * ⚠ **`SHAPE_BOUNDS_EXCEEDED` z §16 sem nepatří a je to zjištění, ne opomenutí.**
 * Ta hláška srovnává **vygenerované** meze s objednaným objemem, jenže před
 * meshingem se nic negeneruje: `mesh-worker.ts` dostane kvádr od volajícího a
 * týž kvádr vrátí (`:212`, `:287`), takže poměr by neměl z čeho vzniknout.
 * Patří k bráně před připojením meshe (vlna 3, T19). Co chybí na téhle cestě je
 * něco jiného a je to zapsané jako `T12-boundsratio`: **nikdo nesrovná rozsah,
 * který program doopravdy zabírá, s kvádrem, který si sám deklaruje.** Pozor na
 * záměnu — `shapes[i].targetBounds` je v souřadnicích tvaru a kvádr placementu
 * ve světových, potrubí mezi nimi normalizuje, takže jejich objemy se rovnat
 * nemají a srovnávat je by byla vada, ne kontrola.
 *
 * ## Celý seznam vad, ne první
 *
 * `findBlueprintReferenceIssues()` vrací všechny nálezy schválně a její
 * hlavička říká proč: z jedné věty model opraví jednu věc, takže při jediném
 * nálezu na kolo by se smyčka protočila třikrát nad týmž blueprintem a jedna
 * vada by zůstala nedotčená. Věta proto nese až šest nálezů a u zbytku řekne,
 * kolik jich je.
 */

import { repairRequest } from './local/rejection-prompt';
import { buildCompilerRequest, compileBlueprint, systemInputIssue, type CompilerResult } from './worldstream-compiler';
import type { Grammar, UpstreamRequest } from './prompt';
import type { PlannerEmission } from './worldstream-intent';
import { emissionChunks, mergeEmissionChunks, type ChunkAnswer } from './emission-merge';

/** Přijatý blueprint i s verdiktem, osekáními a opravami. */
export type CompiledBlueprint = Extract<CompilerResult, { readonly ok: true }>;

import { blueprintRejectionSentence, type BlueprintFault } from './blueprint-rejection';

export { blueprintRejectionSentence, type BlueprintFault };

/**
 * Jedno kolo. `fault: null` znamená, že tohle kolo prošlo — takové je nanejvýš
 * jedno a je poslední. Tvar je schválně týž jako `Round` v `local/emit.ts`,
 * aby ho uměl vykreslit jeden panel.
 */
export interface BlueprintRound {
  /** 1 pro první pokus. Kola se počítají od jedničky. */
  readonly attempt: number;
  readonly fault: BlueprintFault | null;
  readonly ms: number;
}

export type BlueprintOutcome =
  /** Model neodpověděl. O takovém běhu se nesmí nic skórovat. */
  | {
      readonly kind: 'unavailable';
      readonly detail: string;
      /**
       * Co se doopravdy vyhodilo — **nezploštěné na text**.
       *
       * `detail` je věta pro operátora a rozhodovat se podle ní znamená mít
       * kontrakt nad řetězcem. Volající, který potřebuje rozlišit „poskytovatel
       * neodpověděl" od „strop odmítl a nikam se nevolalo", se ptá `instanceof`
       * (P15 `T29-readinessledger`); ostatní si dál berou `detail`.
       */
      readonly cause: unknown;
      readonly rounds: readonly BlueprintRound[];
    }
  /**
   * Vada byla na **naší** straně a model se kvůli ní nevolal ani jednou.
   *
   * Vlastní druh, ne `rejected`: odmítnutí je verdikt o odpovědi modelu a tady
   * žádná odpověď není. A ne `unavailable`: ten druh znamená „zeptali jsme se
   * a nedostali jsme nic", což by v produktu vydalo větu „the model did not
   * answer" o běhu, kde se nikdo neptal. `rounds` je vždycky prázdné.
   */
  | {
      readonly kind: 'invalidInput';
      readonly detail: string;
      readonly rounds: readonly BlueprintRound[];
    }
  | {
      readonly kind: 'compiled';
      readonly result: CompiledBlueprint;
      readonly rounds: readonly BlueprintRound[];
    }
  | {
      readonly kind: 'rejected';
      readonly fault: BlueprintFault;
      readonly rounds: readonly BlueprintRound[];
    };

/**
 * Výchozí strop kol. **Tři, a je to jiné odůvodnění než u lokální smyčky.**
 *
 * `MAX_ROUNDS` v `local/emit.ts` drží tři kvůli času: jedna emise na GPU má
 * medián 33,7 s, takže čtvrté kolo by porotce nevydržel. Tady je vazba na
 * peníze — každé kolo je **placené volání navíc za tutéž větu**, takže čtvrté
 * kolo zdraží nejhorší případ o třetinu za čím dál menší šanci. Model, který
 * vadu neopravil dvakrát, ji obvykle neopraví ani potřetí; od toho je
 * zastavení na nepohnutém odmítnutí níž, které utne dřív než tenhle strop.
 *
 * ⚠ **Je to výchozí hodnota, ne zákon — obojí odůvodnění mluví o placené živé
 * cestě a autorský běh není ani jedno.** Naměřeno 5. 9. 2026 nad prvními
 * sedmnácti větami: **sedm z jedenácti neúspěchů skončilo přesně na stropu**
 * (čtyři volání, tedy planner a všechna tři kola) a **ani jeden z nich se
 * nezastavil na nepohnutém odmítnutí** — model tedy pořád opravoval, jen mu
 * došla kola. Že se ta poslední kola vyplácejí, je vidět na druhé straně:
 * **dva z šesti uložených světů (`c03`, `c15`) potřebovaly celý strop.**
 * Autorský běh je nehlídaný a bez klíče (`G2`), takže tam kolo nestojí nic
 * a strop jen zahazuje rozdělanou práci — proto si ho volající volí sám.
 */
export const MAX_BLUEPRINT_ROUNDS = 3;


/**
 * Požadavek opravného kola. **Systémová zpráva zůstává celá, ukázku nevyhazuje.**
 *
 * ⚠ **Z P12 vlny 2 se sem `retrySystem()` schválně NEPŘENÁŠÍ, a je to oprava
 * nálezu z 31. 8. 2026.** Lokální smyčka ukázku useká z naměřeného důvodu:
 * okno Qwenu je 4 096 tokenů a předchozí emise se s ukázkou do něj nevejde.
 * Tady je model cloudový a jeho okno není vázající omezení — první kolo má
 * 26 938 znaků, tedy zhruba 7 000 tokenů. **Odůvodnění toho řezu se na tuhle
 * cestu nepřenáší, takže se nepřenáší ani řez.**
 *
 * A hlavně by tu škodil. Požadavek prvního kola sám mluví o ukázce
 * („The example above demonstrates shape only… copying its geometry table is
 * rejected") a opravné kolo ho přikládá znovu. Kdyby se ukázka ze systémové
 * zprávy odřízla, ukazovala by ta věta na nejbližší JSON nad sebou — a to je
 * **vlastní odpověď modelu**, kterou má podle téhož promptu zachovat. Model by
 * si přečetl, že ji nesmí opsat, a napsal by geometrii od začátku; vznikla by
 * jiná vada, na kterou zastavení na nepohnutém odmítnutí nedosáhne.
 *
 * Cena za to je 8 041 znaků ukázky navíc v každém opravném kole, tedy zhruba
 * 2 000 tokenů vstupu. Vlastnost, kterou drží test, proto **není** „opravné
 * kolo je kratší" — to by po tomhle rozhodnutí byla nepravda — ale
 * „smyčka sama nepřidává nic než větu a odmítnutou odpověď".
 */
export function buildRepairRequest(
  first: UpstreamRequest,
  previous: unknown,
  fault: BlueprintFault,
): UpstreamRequest {
  const inputDiagnosis = visitorInputDiagnosis(previous, fault);
  return {
    model: first.model,
    system: first.system,
    user: repairRequest(first.user, previous, `${blueprintRejectionSentence(fault)}${inputDiagnosis}`),
  };
}

/** Grounded feedback for a missing activation input, not a rewrite of authored behavior.
 * onClick lowers to clicked; visitor dispatch and witness replay only produce acted.
 * Keep frozen grammar and simulator semantics intact. */
function visitorInputDiagnosis(previous: unknown, fault: BlueprintFault): string {
  if (fault.reason !== 'WORLD_REJECTED' || fault.world?.rejection.stage !== 'witness'
    || fault.world.rejection.reason !== 'NO_WIN') return '';
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const sim = record(record(record(previous).world).sim), rules = record(sim.rules);
  const clicked = Object.entries(rules).filter(([, rule]) => record(record(rule).event).kind === 'onClick');
  if (!clicked.length) return '';
  const actors = Object.entries(record(sim.entities)).filter(([, entity]) => record(entity).role === 'actor').map(([id]) => id);
  const event = record(record(clicked[0][1]).event);
  const target = typeof event.entity === 'string' ? event.entity : '<existing visible object entity>';
  const example = { kind: 'onAction', actor: actors[0] ?? '<existing visible actor entity>', actionId: 'activate', target };
  return `\nINPUT_CONTRACT: ${clicked.slice(0, 6).map(([id]) => JSON.stringify(id)).join(', ')} use onClick, but visitor controls and witness replay emit onAction/acted, not clicked.`
    + ` These click rules cannot be triggered by sim.witness.ops. Use an explicit declared visitor action, for example ${JSON.stringify(example)},`
    + ' with matching actor/actionId/target in the witness. Keep the requested state-changing effects and their guards; do not add an unconditional win or increase the horizon. Keep geometry and placements unchanged.';
}

/**
 * Dvě odmítnutí, mezi kterými se nic nepohnulo.
 *
 * **`detail` je v porovnání schválně**, na rozdíl od lokální smyčky, které
 * stačí fáze a seznam vad. Polovina důvodů compileru vrací `issues: []` —
 * `PLACEMENT_MISMATCH`, `GEOMETRY_NOT_AUTHORED`, `NOT_AN_OBJECT` — takže bez
 * `detail` by dvě **různé** vady téhož druhu („neumístil jsi zeď", pak
 * „neumístil jsi kopuli") vypadaly jako nepohnuté a smyčka by se zastavila
 * uprostřed pokroku.
 *
 * **Porovnává se proti všem odehraným kolům, ne jen proti minulému — od
 * 5. 9. 2026.** Kmit A→B→A jinak projde celý: po kole 2 se B liší od A, takže
 * kolo 3 běží a skončí na téže vadě jako kolo 1. Do 5. 9. to nestálo nic
 * (spočítáno 31. 8.: při stropu tři se to pozná až po třetím volání, které se
 * stejně muselo udělat), a proto se to nedělalo. Podmínka z té úvahy je dnes
 * splněná: `maxRounds` si volí volající a autorský běh jde nad tři, takže kolo
 * čtvrté a další se opravdu dá prokmitat. Zapsáno jako `T12-oscillation`.
 */
function sameFault(before: BlueprintFault, after: BlueprintFault): boolean {
  return (
    before.reason === after.reason &&
    before.detail === after.detail &&
    before.issues.length === after.issues.length &&
    before.issues.every((issue, at) => issue === after.issues[at])
  );
}

/** Port modelu. Vrací **rozpársovanou odpověď**, ne text — parsování je věc volajícího. */
export type BlueprintEmitter = (request: UpstreamRequest) => Promise<unknown>;

export interface RepairInput {
  readonly onVisualPreview?: (preview: VisualPreview, attempt: number) => void;
  readonly observePhase?: PhaseObserver;
  readonly plan: PlannerEmission;
  readonly grammar: Grammar;
  /** Semínko relace. Píše ho systém, ne model. */
  readonly sessionSeed: number;
  readonly emit: BlueprintEmitter;
  /**
   * Hodiny pro měření kol. Výchozí `Date.now`. **Není to replay cesta** — `ms`
   * v kole je zpráva pro člověka, ne vstup do hashe.
   */
  readonly now?: () => number;
  /**
   * Kolik kol si tahle cesta smí dovolit. Výchozí `MAX_BLUEPRINT_ROUNDS`.
   *
   * **Je to volba volajícího, protože strop platí peníze, a ne každá cesta je
   * platí stejně.** Živá relace u porotce má za každé kolo placené volání
   * a čeká u toho člověk — tam zůstávají tři. Autorský běh (`G2` z 5. 9. 2026:
   * žádný klíč, Codex na předplatném) je nehlídaný a zdarma, takže tam strop
   * nekupuje nic a jen zahazuje rozdělanou práci.
   */
  readonly maxRounds?: number;
  /**
   * Napsat svět na několik požadavků místo jednoho.
   *
   * **Výchozí je `false`, tedy dnešní jediné volání.** Rozřezání se zapíná
   * volajícímu, protože mění počet placených volání na jeden svět — z jednoho
   * na tři. Že se kusy dají slepit beze ztráty, je naměřené nad archivem
   * (`evals/worldstream/chunked-compile.json`: 52 z 52 bajtově týž blueprint);
   * že je Astra dobře napíše, když nevidí zbytek světa, naměřené **není**
   * a čeká na živý běh.
   *
   * Kusy letí **souběžně** (`emitChunks`): každý `emit` je u stropu vlastní
   * rezervace, takže tři kusy jsou tři započtená volání a odmítnutý kus nechá
   * relaci v pojmenovaném stavu, ne v půlce světa (`chunked-live.test.ts`).
   *
   * `true` i `3` jsou tři kusy; `2` je dvoukusý řez `scene` + `rules`
   * (P22 T16, měřený proti jedinému volání, ne zapnutý produktu).
   */
  readonly chunked?: boolean | 2 | 3;
}

/**
 * Jedno kolo přes několik kusů: N požadavků **naráz**, jedna slepená odpověď,
 * jeden blueprint.
 *
 * Kusy letí souběžně, protože celé čekání je model, jak píše (medián 103 s
 * na jednu odpověď, 13. 9. 2026): svět má trvat nejdelší kus, ne součet tří.
 * Souběh smí být, protože každý `emit` je u stropu vlastní rezervace
 * (`cloudEmitter`), takže tři kusy jsou tři započtená volání a strop odmítne
 * první, který by ho překročil.
 *
 * **Čeká se na všechny, i když jeden spadl.** Kus, který už letí, se nedá
 * odvolat a jeho rezervace se vyrovnává až po odpovědi; vrátit výsledek dřív
 * by nechalo peníze držené a relaci „v půlce světa". Až po dolétnutí se
 * vybírá příčina: odmítnutí stropem (`SpendRefusalError`) má přednost před
 * výpadkem, aby relace skončila `SPEND_CAP_BLOCKED` a ne „model nedostupný".
 * Pozná se podle `name`, ne `instanceof`: tenhle modul táhne `proxy.ts` do
 * klientského bundlu a `spend-cap.ts` stojí na `node:fs`, takže by ho
 * hodnotový import shodil celý `next build` (naměřeno 19. 9. 2026).
 *
 * `null` znamená „tudy to nešlo, zkus to jedním voláním" — a vrací se **jen**
 * když se kusu nedostalo odpovědi vůbec (rozbité prostředí). Odmítnutí od
 * brány i rozpor při slepení jsou výsledky, ne důvod tiše přejít na starou
 * cestu: kdyby se přecházelo, report by ukazoval úspěch tam, kde řezání
 * selhalo.
 */
async function emitChunks(input: RepairInput, clock: () => number): Promise<BlueprintOutcome | null> {
  const startedAt = clock();
  const requests = emissionChunks(input.chunked === 2 ? 2 : 3).map((chunk) => ({ chunk, request: buildCompilerRequest(input.plan, input.grammar, chunk) }));
  const lastRequest = requests[requests.length - 1].request;

  const settled = await Promise.allSettled(
    requests.map(({ request }) => observePhaseAsync(input.observePhase, 'blueprint-emitter', () => input.emit(request))),
  );

  const failures = requests.flatMap(({ chunk }, index) => {
    const result = settled[index];
    return result.status === 'rejected' ? [{ chunk, thrown: result.reason as unknown }] : [];
  });
  if (failures.length > 0) {
    const cause = failures.find(({ thrown }) => thrown instanceof Error && thrown.name === 'SpendRefusalError')?.thrown ?? failures[0].thrown;
    const detail = failures
      .map(({ chunk, thrown }) => `chunk ${chunk}: ${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)}`)
      .join('; ');
    return { kind: 'unavailable', detail, cause, rounds: [] };
  }

  const answers: ChunkAnswer[] = requests.map(({ chunk }, index) => ({
    chunk,
    answer: (settled[index] as PromiseFulfilledResult<unknown>).value,
  }));

  const merged = mergeEmissionChunks(answers);
  const ms = clock() - startedAt;
  if (!merged.ok) {
    const fault: BlueprintFault = { reason: 'WRONG_SHAPE', detail: `${merged.reason}: ${merged.detail}`, issues: [] };
    return { kind: 'rejected', fault, rounds: [{ attempt: 1, fault, ms }] };
  }

  const result = observePhase(input.observePhase, 'blueprint-validation-and-lowering', () =>
    compileBlueprint(merged.answer, input.plan, {
      sessionSeed: input.sessionSeed,
      upstream: lastRequest,
      assets: WORLDSTREAM_ASSETS,
    }),
  );

  if (result.ok) return { kind: 'compiled', result, rounds: [{ attempt: 1, fault: null, ms }] };

  if (result.preview) input.onVisualPreview?.(result.preview, 1);
  const fault: BlueprintFault = {
    reason: result.reason,
    detail: result.detail,
    issues: result.issues,
    ...(result.world === undefined ? {} : { world: result.world }),
  };
  return { kind: 'rejected', fault, rounds: [{ attempt: 1, fault, ms }] };
}

/**
 * Protočí emisi blueprintu, dokud jedna neprojde branou, nejvýš `maxRounds`krát.
 *
 * **Časový rozpočet tu schválně není.** Lokální smyčka ho má, protože měří
 * vlastní GPU a ta se umí zaseknout; tady drží čas timeout klienta
 * (`src/server/upstream.ts`) a druhá lhůta by musela vzniknout z čísla, které
 * nikdo nezměřil — živou latenci cloudové cesty měří až T14. Bound je počet
 * kol, a ten je vymahatelný bez hodin.
 */
export async function compileWithRepair(input: RepairInput): Promise<BlueprintOutcome> {
  // **Před prvním voláním, ne po třech.** Vadné semínko nebo prázdný záměr jsou
  // pole, která píše systém; model je neumí opravit, protože je vůbec nepíše.
  // Poslat mu je znamená zaplatit třikrát za nic — a report by to pak četl
  // jako neschopnost modelu.
  const systemIssue = systemInputIssue(input.sessionSeed, input.plan.intent);
  if (systemIssue !== null) return { kind: 'invalidInput', detail: systemIssue, rounds: [] };

  const first = buildCompilerRequest(input.plan, input.grammar);
  const clock = input.now ?? Date.now;

  if (input.chunked !== undefined && input.chunked !== false) {
    const chunked = await emitChunks(input, clock);
    // Slepení selhalo → je to vada odpovědi jako každá jiná a jde do téhož
    // tvaru výsledku. Nepřepisuje se na jediné volání potichu: to by zakrylo,
    // že řezání v tomhle případě nefunguje, a report by četl úspěch.
    if (chunked !== null) return chunked;
  }

  const rounds: BlueprintRound[] = [];
  const seen: BlueprintFault[] = [];
  let previous: unknown = null;
  let last: BlueprintFault | null = null;

  const maxRounds = input.maxRounds ?? MAX_BLUEPRINT_ROUNDS;

  for (let attempt = 1; attempt <= maxRounds; attempt += 1) {
    const request = last === null ? first : buildRepairRequest(first, previous, last);
    const startedAt = clock();

    let answer: unknown;
    try {
      answer = await observePhaseAsync(input.observePhase, 'blueprint-emitter', () => input.emit(request));
    } catch (thrown) {
      // Rozbité prostředí není verdikt o blueprintu. Kola, která už proběhla,
      // se ale nezahazují — je z nich vidět, kam se to dostalo.
      const message = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
      return { kind: 'unavailable', detail: message, cause: thrown, rounds };
    }

    // Brána dostane požadavek **toho kola**, ne prvního: verdikt nesmí tvrdit
    // o modelu něco, co nedostal, a od opravného kola se obojí liší.
    const result = observePhase(input.observePhase, 'blueprint-validation-and-lowering', () => compileBlueprint(answer, input.plan, {
      sessionSeed: input.sessionSeed,
      upstream: request,
      assets: WORLDSTREAM_ASSETS,
    }));
    const ms = clock() - startedAt;

    if (result.ok) {
      rounds.push({ attempt, fault: null, ms });
      return { kind: 'compiled', result, rounds };
    }

    if (result.preview) input.onVisualPreview?.(result.preview, attempt);

    const fault: BlueprintFault = {
      reason: result.reason,
      detail: result.detail,
      issues: result.issues,
      ...(result.world === undefined ? {} : { world: result.world }),
    };
    rounds.push({ attempt, fault, ms });

    // Nepohnuté odmítnutí: tutéž vadu model opravit neumí a další placené
    // volání by za ni nic nekoupilo. **Porovnává se proti všem kolům, ne jen
    // proti minulému** — kmit A→B→A jinak projde celý (`T12-oscillation`).
    if (seen.some((earlier) => sameFault(earlier, fault)))
      return { kind: 'rejected', fault, rounds };

    seen.push(fault);
    previous = answer;
    last = fault;
  }

  // Strop došel. `last` tu nemůže být `null`: smyčka proběhla aspoň jednou a
  // každý průchod ho nastaví, nebo se z ní vrátí dřív.
  return { kind: 'rejected', fault: last as BlueprintFault, rounds };
}
