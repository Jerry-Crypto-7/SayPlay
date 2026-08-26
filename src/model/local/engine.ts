/**
 * Model běžící v prohlížeči — načtení vah a jedno svázané dokončení.
 *
 * ## Proč se `@mlc-ai/web-llm` neimportuje nahoře
 *
 * Ten balík je jeden soubor o 6,5 MB. Statický import by ho vtáhl do bundlu
 * stránky, takže by se stahoval i na strojích, které WebGPU nemají a model
 * nikdy nespustí (větev `none` z `./capability`). Dynamický `import()` ho
 * vyžádá až ve chvíli, kdy `detectRuntime()` řekne `large` nebo `small` — tedy
 * až když je jisté, že se doopravdy použije.
 *
 * ## Proč tvar požadavku bydlí tady, a ne v měřidle
 *
 * `evals/local-model/measure-grammar.ts` měří, kolik z toho, co model napíše,
 * projde produkčním validátorem. To číslo popisuje produkci jen tehdy, když
 * měření posílá **týž požadavek**, jaký posílá produkce: tentýž svázaný tvar,
 * tentýž strop tokenů, tentýž model. Dvě kopie těch konstant by se rozešly a
 * naměřená hodnota by pak popisovala něco, co uživatel nikdy nedostane. Měřidlo
 * si je proto bere odsud.
 */

import { EXAMPLE_MARKER } from '../prompt';

import type { Runtime } from './capability';

/** Váhy pro větev `large`. 979 MB, WebGPU, ~8 GB paměti. */
export const LARGE_MODEL = 'Qwen3-1.7B-q4f16_1-MLC';

/** Váhy pro větev `small`. Tentýž model je i reprodukcí chyby `mlc-ai/web-llm#807`. */
export const SMALL_MODEL = 'Qwen3-0.6B-q4f16_1-MLC';

/**
 * Které váhy patří ke které větvi. `cloud` ani `none` model v prohlížeči
 * nespouštějí, takže pro ně žádné nejsou — a `null` je tu odpověď, ne chyba.
 */
export function modelForRuntime(runtime: Runtime): string | null {
  if (runtime === 'large') return LARGE_MODEL;
  if (runtime === 'small') return SMALL_MODEL;
  return null;
}

/**
 * Strop odpovědi. Produkční příklad má konzervativně 1 246 rozpočtových tokenů;
 * 2 560 drží nejméně dvojnásobnou rezervu a pořád omezuje zacyklenou odpověď.
 * Vyšší strop sám o sobě čas nestojí — T2 vypíná uvažování a platná emise skončí
 * na vlastním koncovém tokenu.
 */
export const MAX_OUTPUT_TOKENS = 2560;

/**
 * Tvar, na který se sváže dekodér.
 *
 * Je to **obálka, kterou vyjmenovává systémový prompt** (`../prompt.ts`: „Its
 * top-level fields are exactly: irVersion, simRevision, lookRevision, sim,
 * look"), ne celé schéma světa. Vnitřek `sim` a `look` zůstává na modelu, a
 * právě ten vnitřek pak soudí produkční validátor.
 *
 * `sim` smí být `null` — tak se v tomhle kontraktu píše poctivé odmítnutí.
 *
 * ## Proč se sem vítězné pravidlo NEVYNUCUJE — naměřeno 26. 8. 2026
 *
 * Ze 24 zaznamenaných emisí jich 15 nemá jedinou akci `win`, takže se svět
 * nedá dohrát. Nabízelo se to vynutit dekodérem: `sim.rules` s
 * `required: ['win']` a vítězné pravidlo s `actions: [{ kind: 'win' }]`.
 * **V prohlížeči to nefunguje a je to změřené na živém modelu**, čtyři věty
 * ke každé variantě:
 *
 * 1. Celá kostra (`layout`/`sockets`/`entities`/`state`/`rules` + tvar
 *    vítězného pravidla) → `BindingError: Expected null or instance of
 *    VectorInt` do dvou sekund, **4 ze 4**. Model se vůbec nerozeběhne;
 *    gramatika se rozbije při překladu schématu.
 * 2. Jen `required` nad `sim` a `rules.required: ['win']` → přeloží se, ale
 *    emise padá na `schema/SCHEMA_VIOLATION`, 2 ze 2.
 * 3. Totéž s `additionalProperties: true` → přeloží se, běží **pomaleji**
 *    (55–65 s proti 41 s) a vydá useknuté tělo, 2 ze 2.
 *
 * Mechanismus sedí na všechny tři: xgrammar překládá JSON schéma ve striktním
 * režimu, kde deklarované `properties` jsou **celý** seznam povolených klíčů.
 * Částečný tvar se tím nestává minimem, ale maximem — `rules` s jedinou
 * deklarovanou vlastností `win` je mapa, do které nejde napsat druhé pravidlo.
 * Vynutit vítězné pravidlo by proto znamenalo rozvinout do gramatiky celý
 * `simSchema`, tedy stovky uzlů, a to je přesně ten obsah, který je odpovědí
 * na větu.
 *
 * Volná obálka drží naměřených `schemaValid 198/200 = 0,990` (T8). Povinnost
 * vítězného pravidla proto nese **prompt** (`../prompt.ts`, „THE WORLD MUST BE
 * WINNABLE") a vymáhá ji certifikace, ne dekodér.
 */
export const FORCED_SHAPE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    irVersion: { type: 'string' },
    simRevision: { type: 'integer' },
    lookRevision: { type: 'integer' },
    sim: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    look: { type: 'object' },
  },
  required: ['irVersion', 'simRevision', 'lookRevision', 'sim', 'look'],
});

/** Co model vrátil. `raw` je text tak, jak přišel — neuklizený schválně. */
export interface Completion {
  readonly raw: string;
  /** `stop` = domluvil, `length` = došel strop. Rozdíl je vidět ve verdiktu. */
  readonly finishReason: string;
}

/** Minimum, které od modelu potřebuje `./emit`. Injektuje se, aby šlo emisi testovat bez GPU. */
export interface ChatEngine {
  /**
   * Které váhy tohle doopravdy jsou. Je to součást rozhraní, protože se to
   * zapisuje do provenience verdiktu — a `buildEmissionRequest()` tam sám od
   * sebe píše serverový model, takže bez toho by prohlížečový svět tvrdil, že
   * ho napsal někdo jiný.
   */
  readonly modelId: string;
  complete(system: string, user: string): Promise<Completion>;
  unload(): Promise<void>;
}

/**
 * Požadavek na dokončení. Čistá funkce, aby se dal ověřit bez prohlížeče —
 * `temperature: 0` a `seed: 1` jsou tu proto, že celý projekt stojí na tom, že
 * se týž vstup chová stejně.
 */
export function completionRequest(system: string, user: string): Record<string, unknown> {
  const markerAt = system.indexOf(EXAMPLE_MARKER);
  const example = markerAt < 0 ? null : system.slice(markerAt + EXAMPLE_MARKER.length).trim();
  const instructions = markerAt < 0 ? system : system.slice(0, markerAt).trimEnd();
  const messages = [
    // Qwen3 rozumí direktivě i tehdy, když klient nepředá vlastní parametr
    // šabloně. Obě cesty držíme schválně: WebLLM už parametr podporuje, ale
    // systémová zpráva zůstává kompatibilní pojistkou.
    { role: 'system', content: `${instructions}\n\n/no_think` },
    ...(example === null
      ? []
      : [
          {
            role: 'user',
            content: 'Build a room where the player finds a card, uses it at a lever, and exits through a gate.',
          },
          { role: 'assistant', content: example },
        ]),
    { role: 'user', content: user },
  ];

  return {
    messages,
    response_format: { type: 'json_object', schema: FORCED_SHAPE_SCHEMA },
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    seed: 1,
    extra_body: { enable_thinking: false },
  };
}

/** Tvar, který z `@mlc-ai/web-llm` doopravdy používáme. Zbytek balíku nás nezajímá. */
interface MlcEngine {
  chat: {
    completions: {
      create(request: unknown): Promise<{
        choices: { finish_reason?: string; message?: { content?: string | null } }[];
      }>;
    };
  };
  unload(): Promise<void>;
}

interface MlcModule {
  CreateMLCEngine(
    model: string,
    config: { initProgressCallback(report: { text: string }): void },
  ): Promise<MlcEngine>;
}

/**
 * Stáhne váhy a vrátí model připravený odpovídat.
 *
 * `onProgress` dostává text, který hlásí WebLLM (kolik z vah je staženo). Je
 * povinný schválně: stahuje se skoro gigabajt a obrazovka, která během toho
 * mlčí, vypadá jako zaseknutá.
 */
export async function loadEngine(runtime: Runtime, onProgress: (text: string) => void): Promise<ChatEngine> {
  const model = modelForRuntime(runtime);
  if (model === null) throw new Error(`runtime ${runtime} nespouští model v prohlížeči`);

  // Žádost o trvalé úložiště odchází PŘED stahováním, ne po něm: prohlížeč se
  // rozhoduje podle toho, kolik místa je zabráno, a po stažení gigabajtu je
  // odpověď méně pravděpodobná než před ním. Nečeká se na ni — je to žádost,
  // ne podmínka, a načítání modelu se kvůli ní nesmí zdržet.
  void requestPersistentStorage();

  const webllm = (await import('@mlc-ai/web-llm')) as unknown as MlcModule;
  const engine = await webllm.CreateMLCEngine(model, {
    initProgressCallback: (report) => onProgress(report.text),
  });

  return {
    modelId: model,
    async complete(system, user) {
      const reply = await engine.chat.completions.create(completionRequest(system, user));
      return {
        raw: reply.choices[0]?.message?.content ?? '',
        finishReason: reply.choices[0]?.finish_reason ?? '',
      };
    },
    unload: () => engine.unload(),
  };
}

// ---------------------------------------------------------------------------
// Trvalé úložiště pro stažené váhy
// ---------------------------------------------------------------------------

/**
 * Co z `navigator.storage` doopravdy potřebujeme. Celý `StorageManager` sem
 * netaháme, aby šlo rozhraní podstrčit v testu jedním objektem.
 */
export interface StorageLike {
  persist(): Promise<boolean>;
}

/**
 * Požádá prohlížeč, aby mezipaměť s vahami nevyhazoval.
 *
 * ## Proč se o to vůbec žádá
 *
 * WebLLM ukládá skoro gigabajt do Cache API. Bez téhle žádosti je to úložiště
 * „best-effort": prohlížeč ho smí vyhodit, kdykoli mu dojde místo — a další
 * návštěva pak stahuje znovu. Slib „podruhé se nestahuje" je tedy přesně tak
 * pevný jako tahle žádost.
 *
 * ## Co se vrací a proč to nejsou jen `true`/`false`
 *
 * `null` znamená **prohlížeč se nezeptal**, protože rozhraní nemá (Safari do
 * 16.4, staré Chromium, jakýkoli kontext bez `navigator.storage`). To je něco
 * jiného než `false`, což je odmítnutí. Slít obojí do `false` by v logu tvrdilo,
 * že prohlížeč odmítl, ačkoli se ho nikdo nezeptal.
 *
 * Výjimka z `persist()` se počítá taky jako `null`: rozhraní tam je, ale
 * odpověď nedalo. Pád při žádosti o úložiště nesmí shodit načítání modelu.
 */
export async function askForPersistence(
  storage: StorageLike | undefined,
  log: (message: string) => void,
): Promise<boolean | null> {
  if (storage?.persist === undefined) {
    log('[storage] persist() není v tomhle prohlížeči — mezipaměť vah může být vyhozena');
    return null;
  }
  try {
    const granted = await storage.persist();
    log(
      granted
        ? '[storage] persist() povolen — mezipaměť vah přežije tlak na místo'
        : '[storage] persist() zamítnut — váhy se možná budou stahovat znovu',
    );
    return granted;
  } catch (thrown) {
    log(`[storage] persist() selhal: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    return null;
  }
}

/**
 * Zapamatovaná odpověď. Žádost odejde **nejvýš jednou za život stránky**, protože
 * druhá by na tutéž otázku dostala tutéž odpověď a v Chrome navíc umí vyvolat
 * další vyskakovací dotaz na uživatele.
 */
let persistence: Promise<boolean | null> | null = null;

/** Produkční obálka nad `askForPersistence`: zeptá se jednou, pak vrací totéž. */
export function requestPersistentStorage(): Promise<boolean | null> {
  persistence ??= askForPersistence(
    typeof navigator === 'undefined' ? undefined : (navigator.storage as StorageLike | undefined),
    (message) => console.info(message),
  );
  return persistence;
}
