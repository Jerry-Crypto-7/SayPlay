/**
 * **Živá větev generování — HTTP volání poskytovatele.**
 *
 * Druhá implementace `GenerationBranch`. Prochází stejnou kontraktovou sadou
 * jako offline větev v `src/server/mock/`; liší se jen fixture, nikdy tvrzení.
 *
 * ## Cloud je od P13 hlavní cesta, ne zakázaná
 *
 * **Rozhodnutí ze 14. 8. 2026 („placený model se volat nebude") je od 27. 8.
 * 2026 překonané** — P13 dělá z cloudového modelu hlavní cestu, protože lokální
 * Qwen3-1.7B má medián 35–39 s na větu a to porotce nevydrží. Vypínač zůstává
 * beze změny: bez `WORLDSMITH_BRANCH=live` a bez klíče tahle větev **nikam
 * nevolá** a vrací `BRANCH_UNCONFIGURED`. Změnilo se, že ten stav už není cíl,
 * jen výchozí hodnota.
 *
 * Koncový bod nemá výchozí hodnotu schválně. Zapsaná adresa v kódu je způsob,
 * jak se jednou omylem zavolá ven. Adresa, kterou sem patří dosadit, je
 * v `.env.example` u `WORLDSMITH_MODEL_ENDPOINT`.
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

/**
 * Úrovně úsilí, které Messages API zná. **Zavřený seznam schválně:** neznámou
 * hodnotu odmítne poskytovatel čtyřistovkou a živá větev je mrtvá přesně v té
 * konfiguraci, kterou někdo opsal z dokumentace s překlepem. Táž vada jako
 * `{"model": ""}` naměřená 21. 8. 2026, jen o jedno pole vedle.
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type Effort = (typeof EFFORT_LEVELS)[number];

export interface UpstreamConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly effort: Effort;
  readonly pricing: Pricing;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * **Proč `low` a ne výchozí hodnota poskytovatele.**
 *
 * Na `claude-opus-5` běží uvažování **zapnuté i tehdy, když se pole `thinking`
 * vůbec nepošle**, a výchozí úsilí je `high`. Tahle větev ale emituje jeden
 * JSON podle zavřené gramatiky, ne řešení úlohy — a brána K2 chce p95 do
 * hrubého světa **pod 3 sekundy**. Výchozí hodnota poskytovatele je proto pro
 * tuhle cestu špatná, i když je pro většinu volání správná.
 *
 * **Uvažování se nevypíná**, přestože by to vypadalo jako přímější páka:
 * s `thinking: {type: "disabled"}` na Opus 5 model občas napíše volání nástroje
 * do viditelného textu místo do bloku a umí protéct značkami `<thinking>` —
 * obojí je zdokumentované chování, ne dohad. Snížené úsilí dá totéž zrychlení
 * bez těch dvou.
 *
 * **Není to naměřené a nikde to netvrď.** Je to hodnota vybraná z popsaného
 * chování; jestli sedí, rozhodne T14 nad zmrazenou sadou. Proto je přebytelná
 * proměnnou prostředí — aby se dala přeměřit bez zásahu do kódu.
 */
const DEFAULT_EFFORT: Effort = 'low';

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Cena vstupu. **Nevyplněná se dopočítá z ceny výstupu, výslovná nula se
 * respektuje** — a přesně ten rozdíl je jádro vady naměřené 21. 8. 2026.
 *
 * `positiveNumber` se tu použít nedá: ta žádá `> 0`, takže by neuměla odlišit
 * „operátor napsal nulu" od „operátor nenapsal nic". Tichá výchozí nula
 * podhodnocovala rezervaci o celý vstup (~3000 tokenů na volání); nula, kterou
 * někdo napsal, je naproti tomu rozhodnutí a je vidět v konfiguraci.
 *
 * Vadná hodnota (překlep, desetinná čárka, záporné číslo) se chová jako
 * chybějící a dopočítá se — u stropu je přestřelená rezervace bezpečná strana.
 */
/**
 * Úsilí z prostředí. Neznámá i prázdná hodnota padá na `DEFAULT_EFFORT` — na
 * rozdíl od ceny se tady tichá náhrada smí: špatné úsilí stojí latenci, ne
 * peníze navíc, a odmítnout kvůli němu celou cloudovou větev by bylo dražší než
 * ta vada sama.
 */
function effortLevel(raw: string | undefined): Effort {
  const value = (raw ?? '').trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(value) ? (value as Effort) : DEFAULT_EFFORT;
}

function inputPrice(raw: string | undefined, usdPerMTokOut: number): number {
  if (raw === undefined || raw.trim() === '') return usdPerMTokOut;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : usdPerMTokOut;
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
 * **Cena vstupu se nevyžaduje, ale její náhradou je cena výstupu — ne nula.**
 * Původní znění tady tvrdilo, že vstup je „pár stovek tokenů" a nula ho tedy
 * podhodnotí jen nepatrně. **To bylo měřením vyvráceno 21. 8. 2026:** systémová
 * zpráva má ~7000 znaků a prompt až 2000, tedy ~3000 vstupních tokenů. Při
 * ceníku, který používají vlastní testy repozitáře (1000 výstupních tokenů,
 * vstup 3 / výstup 15 USD za Mtok), rezervace kryla 0,015 USD ze skutečných
 * 0,0243 USD — strop 5 USD by pustil ~333 volání za ~8,04 USD, tedy **o 61 %
 * přes**. Při výchozích hodnotách (8000 výstupních, Opus) je přestřel 7,6 %.
 *
 * Náhrada za chybějící cenu vstupu je proto cena výstupu: rezervace tím spíš
 * přestřelí, což je u stropu ta bezpečná strana. Výslovná nula se pořád přijme —
 * to je vědomé rozhodnutí operátora, ne tichá výchozí hodnota, a právě tichá
 * výchozí hodnota byla ta vada.
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
    effort: effortLevel(env.WORLDSMITH_MODEL_EFFORT),
    pricing: {
      usdPerMTokIn: inputPrice(env.WORLDSMITH_USD_PER_MTOK_IN, usdPerMTokOut),
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
  // **Non-finite a záporné počty se tu schválně NEODMÍTAJÍ** — vypadá to jako
  // chybějící kontrola a není. Zkusilo se to 21. 8. 2026 a bylo to horší:
  // `null` se totiž na úspěšné cestě sráží na `{0, 0}` (níž v tomhle souboru),
  // takže z otrávené spotřeby vznikne účtenka na **nula dolarů** a volání je
  // zadarmo. Bez téhle kontroly vyjde cena `Infinity` nebo `NaN`, tu odmítne
  // `release()` v `spend-cap.ts` a účtuje celou rezervaci — bezpečná strana.
  // Chytil to až mutant M2, který kontrolu odstranil a sada zůstala zelená.
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
        // `effort` bydlí uvnitř `output_config`, ne nahoře — nahoře ho API
        // neuvidí a mlčky pojede na výchozím `high`.
        output_config: { effort: config.effort },
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
    // NEsrážet na `{0, 0}`: `null` znamená „účtenku neumíme přečíst" a strop na
    // to musí účtovat rezervaci. Nula znamenala volání zdarma.
    usage,
    provenance: {
      branch: UPSTREAM_BRANCH_ID,
      source: 'upstream-http',
      synthetic: false,
      model: config.model,
    },
  };
}
