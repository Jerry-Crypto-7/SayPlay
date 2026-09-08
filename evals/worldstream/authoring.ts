/**
 * Součástky běhu, kterým Codex uvaří světy dopředu.
 *
 * **Sem patří jen to, co jde změřit bez modelu.** Vlastní běh
 * (`author-worlds.measure.ts`) volá Codex a trvá hodinu; kdyby v něm bydlelo
 * i rozhodování o tom, co se uloží a co přeskočí, testovalo by se to jedině
 * tak, že se zaplatí hodina a změří se poskytovatel. Tady je fingovatelný
 * spouštěč a čistá data, takže sada běží v sekundách.
 *
 * ⚠ **Čtyři pasti volání Codexu, všechny selhávají tiše a všechny stály pokus**
 * (naměřeno 5. 9. 2026). Jsou zapsané u funkcí, kterých se týkají, protože
 * v hlavičce si jich nikdo nevšimne:
 *   1. víceřádkový prompt v argumentu předá **jen první řádek** (vrátí `{}`),
 *   2. bez uzavřeného stdin proces **visí** až do timeoutu (>5 minut),
 *   3. do roury jde **holý JSON** bez banneru a bez značky `codex`,
 *   4. na Windows je v PATH jen `codex.cmd`, takže `execFileSync('codex')`
 *      končí `ENOENT`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Grammar, UpstreamRequest } from '@/model/prompt';
import { buildIntentRequest, readPlannerEmission } from '@/model/worldstream-intent';
import { compileWithRepair } from '@/model/worldstream-repair';
import { emitterFor } from '@/worldstream/authored';
import type { WorldstreamBlueprint } from '@/worldstream/schema';

/**
 * Tvar skladu se **půjčuje z produktu**, neopisuje.
 *
 * Do `T35-actsthree4` tu stála vlastní kopie těch dvou rozhraní. Byla to druhá
 * pravda o témž souboru: pole přidané v produktu se sem nedostalo, takže se
 * autorský běh o něm nedozvěděl a `tsc` mlčel. Sklad má jedno místo, kde se
 * jeho tvar definuje, a je to `src/worldstream/authored.ts`.
 */
export type { AuthoredChange, AuthoredStore, AuthoredWorld } from '@/worldstream/authored';

import type { AuthoredChange, AuthoredStore, AuthoredWorld } from '@/worldstream/authored';

export const STORE_VERSION = 'authored-v1';

/** Jak dopadla jedna věta. */
export interface AuthoringResult {
  readonly id: string;
  readonly kept: boolean;
  /** Proč se nezachovala — fáze z brány, nebo `unavailable`, když Codex selhal. */
  readonly cause: string | null;
  /**
   * Co u té fáze stálo — věta od brány, která odmítla.
   *
   * **Bez ní se rozpad příčin dá jen přečíst, ne opravit.** Běh z 5. 9. 2026
   * nahlásil `witness: 4` a nic dalšího; „svět nebyl dohratelný" ale neříká,
   * jestli hledač cestu nenašel, našel ji nad stropem, nebo runtime spadl —
   * a každá z těch tří se opravuje jinde. Jedna věta stojí ~200 s, takže
   * neuložený důvod znamená ten čas zaplatit znovu.
   */
  readonly detail: string | null;
  readonly seconds: number;
  readonly calls: number;
}

/* ------------------------------------------------------------------ *
 * Odpověď z výpisu.
 * ------------------------------------------------------------------ */

/**
 * JSON z toho, co Codex vytiskl.
 *
 * ⚠ **Past 3: formát závisí na tom, jestli je stdout terminál.** V terminálu
 * tiskne `codex exec` banner, značku `codex`, tělo a `tokens used`; **do roury
 * tiskne jen finální zprávu**, tedy holý JSON a nic jiného. Parser psaný podle
 * terminálu nad rourou nenajde nic a běh se ohlásí jako selhání modelu,
 * přitom odpověď dorazila v pořádku. Zkouší se proto obojí, holý JSON napřed.
 */
export function answerFrom(output: string): unknown {
  const candidates: string[] = [output];

  const marker = output.lastIndexOf('\ncodex\n');
  if (marker !== -1) {
    const stop = output.indexOf('\ntokens used', marker);
    candidates.push(output.slice(marker + 7, stop === -1 ? undefined : stop));
  }

  for (const raw of candidates) {
    const text = raw.replace(/```(?:json)?/g, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  throw new Error(`Codex nevratil JSON. Konec vypisu:\n${output.slice(-600)}`);
}

/**
 * Kde leží `codex.js`, který spouští shim.
 *
 * ⚠ **Past 4.** Shim `codex.cmd` dělá
 * `node <prefix>/node_modules/@openai/codex/bin/codex.js %*`. `shell: true` by
 * past obešel, ale vydal by celý dlouhý prompt cmd.exe na rozebrání podle mezer
 * a uvozovek — proto se volá rovnou to, co volá shim: argumenty jdou do `argv`
 * tak, jak jsou napsané.
 */
export function codexEntry(): string {
  const roots = [
    process.env.APPDATA === undefined ? null : join(process.env.APPDATA, 'npm'),
    '/usr/local/lib',
    '/usr/lib/node_modules/..',
  ].filter((root): root is string => root !== null);

  for (const root of roots) {
    const candidate = join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('codex.js se nenasel — je Codex CLI nainstalovany globalne?');
}

/** Spouštěč, který se dá ve zkoušce vyměnit za předstíraný. */
export type CodexRunner = (contractPath: string) => string;

/**
 * Skutečné volání Codexu.
 *
 * ⚠ **Past 1 a 2 jsou obě v tomhle jediném volání.** Prompt je jednořádkový
 * a ukazuje na soubor, protože víceřádkový argument by předal jen první řádek;
 * `stdio[0]` je `ignore`, protože bez uzavřeného stdin proces visí na vstupu.
 */
export const liveCodex: CodexRunner = (contractPath) =>
  execFileSync(
    process.execPath,
    [
      codexEntry(),
      'exec',
      '--skip-git-repo-check',
      '-c',
      'tools.web_search=false',
      '-c',
      'model_reasoning_effort="medium"',
      `Read the file ${contractPath} and do exactly what it says. Output only the JSON object, nothing else.`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );

/** Požadavek na disk a odpověď zpátky. Kontrakt v souboru je past 1. */
export function askCodex(request: UpstreamRequest, run: CodexRunner = liveCodex): unknown {
  const contract = join(mkdtempSync(join(tmpdir(), 'author-')), 'contract.md');
  writeFileSync(
    contract,
    `${request.system}\n\n----\n\n${request.user}\n\n----\n\nOutput ONLY the JSON object described above. No prose, no explanation, no code fences.\n`,
    'utf8',
  );
  return answerFrom(run(contract));
}

/* ------------------------------------------------------------------ *
 * Sklad: co se ukládá a co se přeskakuje.
 * ------------------------------------------------------------------ */

/**
 * Sklad s doplněným světem. **Nikdy nemutuje ten, který dostal.**
 *
 * Záznam téhož `id` se přepíše, ne přidá podruhé: druhý běh nad toutéž větou je
 * oprava, ne duplikát, a sklad se dvěma `c01` by o tom, který z nich demo
 * ukáže, rozhodoval pořadím v souboru.
 */
export function withWorld(store: AuthoredStore, world: AuthoredWorld): AuthoredStore {
  return {
    version: STORE_VERSION,
    worlds: [...store.worlds.filter((entry) => entry.id !== world.id), world].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  };
}

/** Emise, kterou brána odmítla. Materiál na diagnózu, nikdy ne zdroj světa. */
export interface AuthoringReject {
  readonly id: string;
  readonly prompt: string;
  readonly cause: string | null;
  readonly detail: string | null;
  readonly planner: unknown;
  readonly compiler: unknown;
}

/**
 * Odmítnutá emise doplněná mezi ostatní. **Nikdy nemutuje tu, kterou dostal.**
 *
 * Táž doktrína jako u `withWorld`: druhý pokus o tutéž větu je oprava, ne
 * duplikát. Dva záznamy o `c02` by při čtení rozpadu vypadaly jako dvě různá
 * odmítnutí a odvedly by opravu k neexistujícímu vzoru.
 */
export function withReject(
  rejects: readonly AuthoringReject[],
  reject: AuthoringReject,
): readonly AuthoringReject[] {
  return [...rejects.filter((entry) => entry.id !== reject.id), reject];
}

/**
 * Věty, které běh ještě má uvařit.
 *
 * Přerušitelnost stojí na tomhle jediném filtru: co je ve skladu, se podruhé
 * nevolá. Bez něj by druhý běh po přerušení zaplatil hodinu za práci, kterou má
 * hotovou — a u nehlídaného běhu se to pozná až podle času.
 */
export function stillToAuthor<T extends { readonly id: string }>(
  cases: readonly T[],
  store: AuthoredStore,
): readonly T[] {
  const have = new Set(store.worlds.map((world) => world.id));
  return cases.filter((entry) => !have.has(entry.id));
}

/* ------------------------------------------------------------------ *
 * Report.
 * ------------------------------------------------------------------ */

export interface AuthoringReport {
  readonly measuredAt: string;
  readonly attempted: number;
  readonly kept: number;
  /** Rozpad příčin, ne jedno číslo: „22 z 30" neřekne, co opravit. */
  readonly causes: Readonly<Record<string, number>>;
  readonly secondsTotal: number;
  readonly results: readonly AuthoringResult[];
}

/**
 * Výsledky předchozích dávek, o kterých tahle dávka nic nezmění.
 *
 * **Běh je přerušitelný, takže report musí být taky** — jinak popisuje poslední
 * dávku a tváří se, že popisuje třicet vět. Naměřeno 5. 9. 2026: první dávka
 * uvařila 11 vět (4 uložené, `witness` 4×), druhá by ten rozpad přepsala svým
 * a zbylo by číslo, které nikdo nedokáže sečíst zpátky.
 *
 * Věta, na kterou se sahá znovu, se **zahazuje** — její starý verdikt už
 * neplatí a dva záznamy o téže větě by se v rozpadu počítaly dvakrát.
 */
export function carryOver(
  previous: readonly AuthoringResult[],
  reattempting: readonly { readonly id: string }[],
): readonly AuthoringResult[] {
  const again = new Set(reattempting.map((entry) => entry.id));
  return previous.filter((result) => !again.has(result.id));
}

export function reportFrom(
  results: readonly AuthoringResult[],
  measuredAt: string,
): AuthoringReport {
  const causes: Record<string, number> = {};
  for (const result of results) {
    if (result.cause === null) continue;
    causes[result.cause] = (causes[result.cause] ?? 0) + 1;
  }

  return {
    measuredAt,
    attempted: results.length,
    kept: results.filter((result) => result.kept).length,
    causes,
    secondsTotal: Math.round(results.reduce((sum, result) => sum + result.seconds, 0)),
    results,
  };
}

/**
 * Uloží se tahle věta, nebo se zahodí a proč.
 *
 * **Rozhodnutí bydlí tady, ne v běhu**, a je to jediný důvod, proč tenhle
 * soubor existuje: v `author-worlds.measure.ts` by se dalo změřit jedině tak,
 * že se zaplatí hodina volání. Přitom je to místo, kde se rozhoduje, co uvidí
 * porotce — vadná odpověď, která se sem prosmýkne, skončí v bundlu.
 *
 * **Uloží se jen svět, který prošel branami A postavil se z něj tvar.** Samotné
 * `blueprintValid` nestačí: emise může projít kompilátorem a přesto spadnout na
 * hlínu, a uložený svět, který se nevykreslí, je horší než žádný — vypadá jako
 * hotová práce.
 */
export function outcomeOf(input: {
  readonly thrown: string | null;
  readonly blueprintValid: boolean;
  readonly geometryAuthored: boolean;
  readonly failureStage: string | null;
  readonly failureDetail?: string | null;
  readonly planner: unknown;
  readonly compiler: unknown;
}): { readonly kept: boolean; readonly cause: string | null; readonly detail: string | null } {
  // **`cause` je krátký klíč, `detail` je věta.** Do 5. 9. 2026 se do `cause`
  // lepila i zpráva výjimky, takže každé jiné znění vyrobilo v rozpadu příčin
  // vlastní příčku — rozpad se tím rozpadl na samé jedničky a přestal ukazovat,
  // co se opakuje. Klíčů je proto uzavřená hrst a text jde vedle.
  if (input.thrown !== null) return { kept: false, cause: 'unavailable', detail: input.thrown };
  if (!input.blueprintValid || !input.geometryAuthored)
    return {
      kept: false,
      cause: input.failureStage ?? 'lost',
      detail: input.failureDetail ?? null,
    };
  // Obě emise, ne jedna. Sklad, kterému chybí plán, vydá na planner požadavek
  // `null` a relace skončí odmítnutím, jehož příčina není nikde vidět.
  if (input.planner === null || input.compiler === null)
    return { kept: false, cause: 'incomplete', detail: 'one of the two emissions was never seen' };
  return { kept: true, cause: null, detail: null };
}

/* ------------------------------------------------------------------ *
 * Druhá věta: uvařené změny (`T35-actsthree4`).
 * ------------------------------------------------------------------ */

/**
 * Sklad s doplněnou změnou u jednoho světa. **Nikdy nemutuje ten, který dostal.**
 *
 * Táž doktrína jako u `withWorld()`: záznam téhož `id` se přepíše, ne přidá
 * podruhé — druhý běh nad toutéž větou je oprava, a dvě změny s týmž `id` by
 * o tom, kterou route vydá, rozhodovaly pořadím v souboru.
 *
 * Svět, který sklad nedrží, se **nezakládá**. Změna bez svého světa nemá proti
 * čemu platit: nese `stableId` z blueprintu, který by neexistoval.
 */
export function withChange(
  store: AuthoredStore,
  worldId: string,
  change: AuthoredChange,
): AuthoredStore {
  return {
    version: STORE_VERSION,
    worlds: store.worlds.map((world) =>
      world.id !== worldId
        ? world
        : {
            ...world,
            changes: [...world.changes.filter((entry) => entry.id !== change.id), change].sort(
              (a, b) => a.id.localeCompare(b.id),
            ),
          },
    ),
  };
}

/**
 * Druhé věty, které běh ještě má uvařit.
 *
 * Dvojí filtr, ne jeden: případ patří do fronty jedině tehdy, když sklad **má**
 * jeho svět (bez blueprintu není proti čemu psát operace) a **nemá** jeho
 * změnu. Přerušitelnost stojí na téže druhé půlce jako u světů.
 */
export function stillToChange<T extends { readonly id: string; readonly createId: string }>(
  cases: readonly T[],
  store: AuthoredStore,
): readonly T[] {
  const worlds = new Map(store.worlds.map((world) => [world.id, world]));
  return cases.filter((entry) => {
    const world = worlds.get(entry.createId);
    return world !== undefined && !world.changes.some((change) => change.id === entry.id);
  });
}

/**
 * Uloží se tahle změna, nebo se zahodí a proč.
 *
 * **Rozhodnutí bydlí tady, ne v běhu**, ze stejného důvodu jako `outcomeOf()`:
 * v měřicím souboru by se dalo změřit jedině tak, že se zaplatí volání Codexu.
 *
 * Uloží se jen změna, kterou přijal `readRefineEmission()` — tedy táž brána,
 * kterou projde živá emise v route. Změna, která branou neprošla, by v provozu
 * skončila odmítnutím, takže uložit ji znamená nabídnout porotci zaručenou
 * chybu místo dějství III.
 */
export function changeOutcomeOf(input: {
  readonly thrown: string | null;
  readonly grounded: boolean;
  readonly accepted: boolean;
  readonly rejection: string | null;
}): { readonly kept: boolean; readonly cause: string | null; readonly detail: string | null } {
  if (input.thrown !== null) return { kept: false, cause: 'unavailable', detail: input.thrown };
  // **Nedostupný cíl je vlastní příčina, ne odmítnutá emise.** Věta, kterou
  // grounding nerozřešil, se modelu nikdy neposlala — sloučit ji s odmítnutím
  // by v rozpadu tvrdilo, že model odpověděl špatně, a opravovalo by se to
  // v kontraktu místo ve větě.
  if (!input.grounded)
    return { kept: false, cause: 'grounding', detail: input.rejection };
  if (!input.accepted) return { kept: false, cause: 'refine', detail: input.rejection };
  return { kept: true, cause: null, detail: null };
}

/**
 * Blueprint uvařeného světa, **beze všech volání modelu**.
 *
 * Druhá věta se nedá napsat naslepo: `buildRefineRequest()` chce objekty, jejich
 * dnešní tvar a obě fasety dokumentu, tedy hotový blueprint. Ten se ale nemusí
 * kupovat znovu — sklad drží obě emise, takže se týž řetěz (`planner` →
 * `compileWithRepair`) přehraje nad `emitterFor()` a stojí to nula volání.
 *
 * Je to i jediná poctivá cesta: kdyby se blueprint složil zkratkou kolem
 * kompilátoru, psala by se změna proti světu, který porotci nikdo neukáže.
 */
export async function replayBlueprint(
  world: AuthoredWorld,
  deps: { readonly grammar: Grammar; readonly sessionSeed: number },
): Promise<WorldstreamBlueprint | string> {
  const emit = emitterFor(world);

  const plan = readPlannerEmission(await emit(buildIntentRequest(world.prompt)));
  if (!plan.ok) return `${plan.reason}: ${plan.detail}`;

  const outcome = await compileWithRepair({
    plan: plan.value,
    grammar: deps.grammar,
    sessionSeed: deps.sessionSeed,
    emit,
  });
  return outcome.kind === 'compiled' ? outcome.result.value : `the stored world no longer compiles: ${outcome.kind}`;
}
