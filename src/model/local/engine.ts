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
 * Strop odpovědi. Emise celého světa se do 1400 tokenů vejde (příklad
 * v `../prompt.ts` má řádově stovky tokenů), a co se nevejde, skončí useknuté —
 * což je poctivá odpověď „tvar neudržel". Bez stropu by jediná zacyklená odpověď
 * spolkla celý běh.
 */
export const MAX_OUTPUT_TOKENS = 1400;

/**
 * Tvar, na který se sváže dekodér.
 *
 * Je to **obálka, kterou vyjmenovává systémový prompt** (`../prompt.ts`: „Its
 * top-level fields are exactly: irVersion, simRevision, lookRevision, sim,
 * look"), ne celé schéma světa. Rozvinout do gramatiky celý `simSchema` by
 * svázalo dekodér schématem o stovkách uzlů. Vnitřek `sim` a `look` zůstává na
 * modelu, a právě ten vnitřek pak soudí produkční validátor.
 *
 * `sim` smí být `null` — tak se v tomhle kontraktu píše poctivé odmítnutí.
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
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object', schema: FORCED_SHAPE_SCHEMA },
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    seed: 1,
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
