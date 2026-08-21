/**
 * **Živá větev generování — HTTP volání poskytovatele.**
 *
 * Druhá implementace `GenerationBranch`. Prochází stejnou kontraktovou sadou
 * jako offline větev v `src/server/mock/`; liší se jen fixture, nikdy tvrzení.
 *
 * ## Dnes se nevolá, a přesto tu je
 *
 * Rozhodnutí ze 14. 8. 2026: placený model se volat nebude, `OPENAI_API_KEY` ani
 * jiný klíč se nevkládá. Bez konfigurace proto tahle větev **nikam nevolá** a
 * vrací `BRANCH_UNCONFIGURED` — to je dnešní produkční stav, ne chyba. Kontrakt
 * ale drží celý, aby zapojení poskytovatele byla jedna proměnná prostředí a ne
 * další kolo návrhu.
 *
 * Koncový bod nemá výchozí hodnotu schválně. Zapsaná adresa v kódu je způsob,
 * jak se jednou omylem zavolá ven.
 *
 * ## Transport se vstřikuje
 *
 * `fetchImpl` je parametr, protože jinak by se kontrakt téhle větve nedal
 * ověřit bez sítě — a test, který sahá na síť, měří poskytovatele, ne nás.
 * Tentýž vzor jede v `evals/harness/live.ts` (`transportFor(config, fetchImpl)`),
 * odkud se ale importovat nesmí: `src/server/**` a `evals/harness/**` jsou
 * oddělené vrstvy a jejich stropy útraty o sobě nesmějí vědět.
 *
 * ## Odhad nejhoršího případu
 *
 * Rezervuje se **celý** povolený výstup za plnou cenu a vstup přepočtený
 * z počtu znaků. Dělí se třemi, ne čtyřmi: čtyři znaky na token je průměr, a
 * průměr je pro horní odhad špatná jednotka. Odhad nižší než skutečnost by
 * strop tiše prodloužil.
 */

import { EMISSION_MODEL } from '../model/prompt';

import type { GenerationBranch, GenerationCall, GenerationOutcome } from './pipeline';
import type { Pricing, Usage } from './spend-cap';

export const UPSTREAM_BRANCH_ID = 'live';

/** Konzervativní počet znaků na token pro **horní** odhad vstupu. */
const CHARS_PER_TOKEN = 3;

export interface UpstreamConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly pricing: Pricing;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8000;
const DEFAULT_TIMEOUT_MS = 120_000;

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Konfigurace z prostředí, nebo `null`, když chybí klíč, koncový bod **nebo
 * cena výstupu**.
 *
 * `env` je parametr, ne `process.env` uvnitř — testovat globální čtení jde jen
 * saháním na proces.
 *
 * ## Chybějící cena výstupu je nekonfigurace, ne nula
 *
 * **Naměřeno 21. 8. 2026 nezávislou revizí a je to nejhorší nález téhle úlohy.**
 * Bez ceny vyjde `worstCaseUsd()` nula, `SpendCap.reserve(0)` projde i při
 * stropu nula (`0 > 0` je nepravda) a strop tím **nedrží vůbec nic**: 25 z 25
 * požadavků odešlo k poskytovateli, každý s 8000 výstupními tokeny, zůstatek se
 * ani nehnul a žádný nedostal 429. `/api/generate` přitom nechce přihlášení, tak
 * účet omezuje jen návštěvnost. Vzniklo to zkopírováním `.env.example`, kde ceny
 * schválně prázdné jsou — tedy přesně tou cestou, kterou dokumentace předepisuje.
 *
 * Odmítnutí je proto tady, na úrovni konfigurace, a ne ve stropu: `reserve(0)`
 * je legitimní pro offline větev, která nic nestojí, takže nula sama o sobě
 * vadná není. Vadná je **placená** větev bez ceny. `cloudBranchAvailable()` tím
 * odpoví `false`, což je poctivá odpověď: takhle nastavený cloud nemá jak jet.
 *
 * Táž doktrína jako u dvojčete pro měřicí běhy: `.env.example` i tam říká
 * o ceně výstupu „musí být KLADNÁ" a jeho preflight bez ní běh odmítne. Jméno
 * té proměnné se sem nepíše schválně — hranici mezi oběma stropy drží lexikální
 * test v `./__tests__/pipeline.test.ts` a ten ji hlídá i v komentářích.
 *
 * **Cena vstupu kladná být nemusí, a je to vědomé.** Rezervaci ovládá výstup
 * (8000 tokenů proti pár stovkám vstupních), takže nula na vstupu cenu jen
 * nepatrně podhodnotí — strop pořád drží. Vyžadovat obojí by navíc shodilo dva
 * existující zelené testy, které vědomě nastavují jen výstup.
 */
export function upstreamConfigFromEnv(env: Record<string, string | undefined>): UpstreamConfig | null {
  const endpoint = env.WORLDSMITH_MODEL_ENDPOINT;
  const apiKey = env.WORLDSMITH_MODEL_KEY;
  if (endpoint === undefined || endpoint.length === 0) return null;
  if (apiKey === undefined || apiKey.length === 0) return null;

  // `positiveNumber` by tu nestačila: ta vadnou hodnotu tiše nahradí náhradou,
  // a náhrada za cenu je právě ta nula, která strop vypíná.
  const usdPerMTokOut = Number(env.WORLDSMITH_USD_PER_MTOK_OUT);
  if (!Number.isFinite(usdPerMTokOut) || usdPerMTokOut <= 0) return null;

  return {
    endpoint,
    apiKey,
    // Prázdný řetězec NENÍ chybějící hodnota, dokud to někdo nenapíše: `??` ho
    // propustí a k poskytovateli odejde `{"model": ""}`, na což odpoví 400 a
    // živá větev je mrtvá přesně v té konfiguraci, kterou `.env.example`
    // předepisuje (naměřeno toutéž revizí).
    model: (env.WORLDSMITH_MODEL ?? '').trim() === '' ? EMISSION_MODEL : env.WORLDSMITH_MODEL!.trim(),
    pricing: {
      usdPerMTokIn: positiveNumber(env.WORLDSMITH_USD_PER_MTOK_IN, 0),
      // Ověřená výš, tady se jen dosazuje — jiná cesta sem hodnotu nepustí.
      usdPerMTokOut,
    },
    maxOutputTokens: positiveNumber(env.WORLDSMITH_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS),
    timeoutMs: positiveNumber(env.WORLDSMITH_UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

/**
 * **Existuje cloudová cesta vůbec?** Jediná odpověď na tuhle otázku v celém repu.
 *
 * Musí platit obojí: někdo živou větev **objednal** (`WORLDSMITH_BRANCH=live`) a
 * zároveň je **čím jet** (koncový bod i klíč). Ani jedno samo nestačí, a každý
 * z těch dvou důvodů je jiný:
 *
 * - Objednávka bez klíče by nabídla cestu, která nemá čím jet — uživatel by
 *   dostal 503 místo světa.
 * - Klíč bez objednávky by znamenal, že proměnná zděděná z jiného projektu
 *   tiše přepne produkt na **placenou** cestu. To je ta dražší chyba z těch dvou.
 *
 * ## Tohle NENÍ výběr větve v `/api/generate`, a nesmí se tím stát
 *
 * Routa se ptá na **objednávku** (`WORLDSMITH_BRANCH === 'live'`), tahle funkce
 * na **dostupnost**. Vypadají podobně a liší se přesně v jednom případě, který
 * rozhoduje: objednaná živá větev **bez klíče**. Tady je to `false` (cloud se
 * nenabízí), v routě to pořád znamená živou větev, která odpoví 503
 * `BRANCH_UNCONFIGURED`.
 *
 * Naměřeno 21. 8. 2026: sjednotit obojí do téhle funkce shodí
 * `src/app/api/generate/__tests__/route.test.ts` („živá větev bez konfigurace je
 * 503"), a je to ten test, kdo má pravdu. Server, kterému chybí klíč, by jinak
 * tiše sjel na offline větev a **vydával mock za model** — operátor s překlepem
 * v klíči by se to nedozvěděl nikdy. Vadné nastavení selhává nahlas, stejně jako
 * u rozbitého vypínače stropu v `./spend-cap.ts`.
 */
export function cloudBranchAvailable(env: Record<string, string | undefined>): boolean {
  return env.WORLDSMITH_BRANCH === 'live' && upstreamConfigFromEnv(env) !== null;
}

/**
 * Živá větev. `config: null` znamená nenakonfigurovaný poskytovatel — větev
 * existuje, drží kontrakt a každé volání odmítne, aniž by kamkoli sáhla.
 */
export function upstreamBranch(
  config: UpstreamConfig | null,
  fetchImpl: typeof fetch = fetch,
): GenerationBranch {
  if (config === null)
    return {
      id: UPSTREAM_BRANCH_ID,
      pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
      worstCaseUsd: () => 0,
      generate: () =>
        Promise.resolve({
          ok: false,
          reason: 'BRANCH_UNCONFIGURED',
          detail: 'no upstream endpoint or key is configured; nothing was called',
          usage: null,
        }),
    };

  return {
    id: UPSTREAM_BRANCH_ID,
    pricing: config.pricing,
    worstCaseUsd: (call) => worstCaseUsd(call, config),
    generate: (call) => generate(call, config, fetchImpl),
  };
}

function worstCaseUsd(call: GenerationCall, config: UpstreamConfig): number {
  const inputTokens = Math.ceil((call.request.system.length + call.request.user.length) / CHARS_PER_TOKEN);
  return (
    (inputTokens * config.pricing.usdPerMTokIn + config.maxOutputTokens * config.pricing.usdPerMTokOut) /
    1_000_000
  );
}

function usageOf(payload: unknown): Usage | null {
  const usage = (payload as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage;
  if (typeof usage?.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

async function generate(
  call: GenerationCall,
  config: UpstreamConfig,
  fetchImpl: typeof fetch,
): Promise<GenerationOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxOutputTokens,
        system: call.request.system,
        messages: [{ role: 'user', content: call.request.user }],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (thrown) {
    return {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      detail: `the upstream call did not complete: ${(thrown as Error).message}`,
      usage: null,
    };
  }

  if (!response.ok)
    return {
      ok: false,
      // 4xx je odmítnutý požadavek — odpověď se negenerovala. 5xx je výpadek,
      // u kterého nevíme, jestli se něco spálilo, a účtuje se odhadem.
      reason: response.status < 500 ? 'UPSTREAM_REJECTED' : 'UPSTREAM_UNAVAILABLE',
      detail: `upstream answered ${response.status}`,
      usage: null,
    };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (thrown) {
    return {
      ok: false,
      reason: 'MALFORMED_RESPONSE',
      detail: `the upstream answer is not JSON: ${(thrown as Error).message}`,
      usage: null,
    };
  }

  // Od téhle chvíle spotřebu známe, i když je odpověď nepoužitelná — tokeny
  // se spálily a účtují se skutečností, ne odhadem.
  const usage = usageOf(payload);
  const text = (payload as { content?: { type?: unknown; text?: unknown }[] } | null)?.content?.find(
    (block) => block.type === 'text',
  )?.text;
  if (typeof text !== 'string')
    return {
      ok: false,
      reason: 'MALFORMED_RESPONSE',
      detail: 'the upstream answer carries no text block',
      usage,
    };

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (thrown) {
    return {
      ok: false,
      reason: 'MALFORMED_RESPONSE',
      detail: `the upstream text block is not JSON: ${(thrown as Error).message}`,
      usage,
    };
  }

  return {
    ok: true,
    body,
    usage: usage ?? { inputTokens: 0, outputTokens: 0 },
    provenance: {
      branch: UPSTREAM_BRANCH_ID,
      source: 'upstream-http',
      synthetic: false,
      model: config.model,
    },
  };
}
