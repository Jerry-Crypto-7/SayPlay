import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { observePhase, observePhaseAsync } from '../model/phase-observer';
import { serverPhaseObserver } from './worldstream-metrics';
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
 * Rezervuje se **celý** povolený výstup za plnou cenu a vstup po **jednom
 * tokenu na znak**. Je to strop, ne odhad, a ten rozdíl je celý smysl:
 * `SpendCap` od 1. 9. 2026 nestrhne víc, než na to volání držel, takže
 * rezervace nižší než skutečnost by poctivé volání **podúčtovala**.
 *
 * Do té doby se vstup dělil třemi (~3 znaky na token). Naměřeno: poctivá
 * účtenka `{8000, 8000}` stála 0,240000 USD proti rezervaci 0,219505 USD,
 * tedy **o 9,3 % víc, než se drželo** — a tvrdý ořez na rezervaci by ten
 * rozdíl tiše zahodil. Jeden token na znak dá rezervaci 0,258515 USD (+17,8 %),
 * pod kterou se tatáž účtenka vejde celá.
 *
 * ⚠ **Není to důkaz, jen mez, která v praxi drží.** Token bývá delší než znak,
 * ale `String.length` počítá kódové jednotky UTF-16, takže vzácný vícebajtový
 * znak (emoji, řídké písmo) se může rozpadnout na několik tokenů a rezervaci
 * přerůst. Systémový prompt, který tvoří většinu vstupu, je náš a je ASCII;
 * porotcova věta je proti němu zlomek. Ořez je obrana proti nesmyslu, ne proti
 * nepoctivému poskytovateli — to platí i tady.
 */

import { EMISSION_MODEL } from '../model/prompt';
import type { ChunkName } from '../model/emission-merge';
import { requestChunk, requestStage } from '../model/worldstream-prompt';

import type { GenerationBranch, GenerationCall, GenerationOutcome } from './pipeline';
import type { Pricing, Usage } from './spend-cap';

export const UPSTREAM_BRANCH_ID = 'live';


/**
 * Znaků na token pro **dolní** odhad výstupu — a je schválně jiný než mez,
 * kterou se počítá rezervace.
 *
 * **Dva odhady téže veličiny nesmějí sdílet konstantu, když jejich bezpečná
 * strana míří opačně.** Horní mez rezervace bere jeden token na znak, aby spíš
 * přestřelila (viz hlavička souboru). Dolní hranice účtu musí naopak spíš
 * podstřelit: kdyby vyšla nad skutečnou účtenku, přeúčtovala by **každé
 * poctivé volání**, a hlášená cena by přestala být tou, která se strhla.
 * Zdědit sem tu mez by tu vadu vyrobilo systematicky, na každém požadavku.
 *
 * Dvanáct je zhruba trojnásobek běžných ~4 znaků na token. **Není to naměřené
 * a nikde to netvrď** — tokenizér poskytovatele neznáme, tohle je vědomě
 * velkorysá mez. Cena té velkorysosti je, že hranice pokryje jen asi čtvrtinu
 * skutečné útraty; to stačí, protože úkolem není účtenku zrekonstruovat, ale
 * zařídit, aby se podhlášení nevyplatilo.
 *
 * ⚠ **Neplyne z toho, že hranice zůstane pod rezervací** — první znění tady
 * tvrdilo, že text delší, než kolik `maxOutputTokens` unese, nevznikne. To je
 * předpoklad o poctivosti poskytovatele, tedy jediná věc, kterou tenhle soubor
 * jinde odmítá předpokládat. Naměřeno nezávislou revizí 1. 9. 2026: odpověď
 * 200 s textovým blokem o 2,4 MB a účtenkou `{0, 1}` strhla **celý dolarový
 * strop 5 USD** proti rezervaci 0,2195 USD, takže každý další porotce dostal
 * 429 — přeúčtovávat se začne asi od 105 kB. Hranici proto ořezává
 * `maxOutputTokens`, ne důvěra.
 */
const FLOOR_CHARS_PER_TOKEN = 12;

/**
 * Úrovně úsilí, které Messages API zná. **Zavřený seznam schválně:** neznámou
 * hodnotu odmítne poskytovatel čtyřistovkou a živá větev je mrtvá přesně v té
 * konfiguraci, kterou někdo opsal z dokumentace s překlepem. Táž vada jako
 * `{"model": ""}` naměřená 21. 8. 2026, jen o jedno pole vedle.
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * Čím se ten běh platí.
 *
 * **`api`** je metrovaná cesta: dolary doopravdy tečou a strop v dolarech je
 * ta mez, která kousne. **`subscription`** je cesta přes předplatné (dnes
 * `gpt-5.6-sol` přes `claude-code-proxy`, rozhodnutí `G2` (a) ze 6. 9. 2026):
 * po tokenech se neúčtuje nic, takže každá dolarová částka kolem takového běhu
 * je **přepočet z ceníku**, ne stržený obnos, a `WORLDSMITH_SPEND_CAP_USD`
 * vypadá jako strop, aniž by držel peníze.
 *
 * **Tenhle pojem vede `evals/harness/preflight.ts` od P11 a produkt ho neměl.**
 * Opisuje se jen ten rozdíl, ne kód: `src/server/**` a `evals/harness/**` jsou
 * oddělené vrstvy a jejich stropy o sobě vědět nesmějí.
 */
export type UpstreamProfile = 'api' | 'subscription';

export interface UpstreamConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly effort: Effort;
  readonly pricing: Pricing;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Metrovaná cesta, nebo předplatné. Viz `UpstreamProfile`. */
  readonly profile: UpstreamProfile;
  /**
   * Strop na počet volání, a u `subscription` **jediná mez, která doopravdy
   * kousne**. U `api` je `null` — tam meze drží dolary a počet je jen druhá
   * pojistka proti špatně opsanému ceníku (`src/server/spend-cap.ts`).
   */
  readonly callCap: number | null;
  /**
   * Lokální záloha (P29B T7) z `WORLDSMITH_FALLBACK_ENDPOINT`; klíč chybí,
   * když záloha není, aby se tvar dnešní konfigurace nehnul.
   */
  readonly fallback?: UpstreamConfig;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * **Druhý transport: Codex CLI místo HTTP** (13. 9. 2026, rozhodnutí uživatele
 * „chci Astru").
 *
 * `gpt-6-astra` se přes `claude-code-proxy` zavolat nedá — proxy má seznam
 * modelů natvrdo a končí u gpt-5.6. Jediná cesta k němu z předplatného je
 * `codex exec`, tedy proces na každé volání. Vybírá se **hodnotou koncového
 * bodu**, ne novou proměnnou: `WORLDSMITH_MODEL_ENDPOINT=codex-cli` znamená
 * „žádná adresa, spusť CLI", a všechno ostatní (model, úsilí, strop volání,
 * ceník pro odvozené dolary) zůstává jak je. Klíč se u CLI nepoužije — přihlášení
 * drží Codex sám (`codex login status`) — ale konfigurace ho dál vyžaduje,
 * aby se tahle větev nedala zapnout omylem prázdným prostředím.
 *
 * Prompt je `system` a `user` za sebou, protože CLI má jediné vstupní pole;
 * odpověď jde přes `parseAnswerText` stejně jako z HTTP. Codex k promptu
 * přidává vlastní systémový prompt (~11 tis. tokenů) — účtenka je proto
 * skutečná spotřeba předplatného, ne to, co poslal produkt.
 *
 * Výchozí strop volání je tu **240 s, ne 120 s**: Astra píše compiler
 * v mediánu 100 s a p95 155 s (`evals/worldstream/latency-report.json`).
 */
export const CODEX_CLI_ENDPOINT = 'codex-cli';
const DEFAULT_CLI_TIMEOUT_MS = 240_000;

/**
 * **Třetí transport: lokální llama.cpp** (P29B T7). Hodnota koncového bodu
 * `llamacpp:<kořen serveru>` znamená `llama-server` s OpenAI chat API
 * a výstupem pod gramatikou z `outputSchema`. Dnes jen jako záloha režiséra
 * (`WORLDSMITH_FALLBACK_ENDPOINT`): běží na vlastní GPU, takže je zdarma,
 * nemá klíč a strop volání se na ni nevztahuje.
 */
export const LLAMACPP_PREFIX = 'llamacpp:';
const DEFAULT_FALLBACK_MAX_OUTPUT_TOKENS = 4000;

/**
 * **Čtvrtý transport: hostovaný poskytovatel s OpenAI chat API** (P30A T2).
 * `openai:<kořen API>` (Together, Fireworks, OpenAI) volá tentýž
 * `/v1/chat/completions` jako llama.cpp, jen se platí po tokenech: ceník
 * z prostředí a tentýž strop utrácení jako každé placené volání. Primár se
 * konfiguruje jako dřív (`WORLDSMITH_MODEL_*`), placená záloha vlastními
 * `WORLDSMITH_FALLBACK_*` včetně ceny.
 */
export const OPENAI_PREFIX = 'openai:';

function fallbackConfigFromEnv(env: Record<string, string | undefined>): UpstreamConfig | null {
  const endpoint = (env.WORLDSMITH_FALLBACK_ENDPOINT ?? '').trim();
  if (/^openai:https?:\/\/\S+$/.test(endpoint)) return hostedFallbackFromEnv(endpoint, env);
  if (!/^llamacpp:https?:\/\/\S+$/.test(endpoint)) return null;
  return {
    endpoint,
    // Klíč `llama-server --api-key`; za veřejným tunelem povinný, lokálně smí chybět.
    apiKey: (env.WORLDSMITH_FALLBACK_KEY ?? '').trim(),
    model: (env.WORLDSMITH_FALLBACK_MODEL ?? '').trim() || 'local-fallback',
    effort: DEFAULT_EFFORT,
    pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
    maxOutputTokens: positiveNumber(env.WORLDSMITH_FALLBACK_MAX_OUTPUT_TOKENS, DEFAULT_FALLBACK_MAX_OUTPUT_TOKENS),
    timeoutMs: positiveNumber(env.WORLDSMITH_FALLBACK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    profile: 'subscription',
    callCap: null,
  };
}

/**
 * Placená záloha (P30A T2). Táž doktrína jako primár v `upstreamConfigFromEnv`:
 * bez klíče, modelu nebo kladné ceny výstupu to není záloha zdarma, ale
 * nekonfigurace – a nekonfigurovaná záloha se nezapne vůbec.
 */
function hostedFallbackFromEnv(endpoint: string, env: Record<string, string | undefined>): UpstreamConfig | null {
  const apiKey = (env.WORLDSMITH_FALLBACK_KEY ?? '').trim();
  const model = (env.WORLDSMITH_FALLBACK_MODEL ?? '').trim();
  const usdPerMTokOut = Number(env.WORLDSMITH_FALLBACK_USD_PER_MTOK_OUT);
  const maxOutputTokens = positiveNumber(env.WORLDSMITH_FALLBACK_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
  if (apiKey === '' || model === '') return null;
  if (!Number.isFinite(usdPerMTokOut) || usdPerMTokOut <= 0 || (maxOutputTokens * usdPerMTokOut) / 1_000_000 <= 0) return null;
  return {
    endpoint,
    apiKey,
    model,
    effort: effortLevel(env.WORLDSMITH_FALLBACK_EFFORT),
    pricing: { usdPerMTokIn: inputPrice(env.WORLDSMITH_FALLBACK_USD_PER_MTOK_IN, usdPerMTokOut), usdPerMTokOut },
    maxOutputTokens,
    timeoutMs: positiveNumber(env.WORLDSMITH_FALLBACK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    profile: 'api',
    callCap: null,
  };
}

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

/**
 * **Kolik uvažování si který kus světa zaslouží — jediné místo, kde to stojí.**
 *
 * Naměřeno 14. 9. 2026 (`evals/worldstream/latency-report.json`):
 * `gpt-6-astra@high` má medián 258 s a tři světy ze sedmi přes 300 s, což je
 * mez, ve které hosting spojení utne; `astra@low` doručila 8 z 8 při mediánu
 * 142 s. Plošně snížit úsilí ale nejde: geometrie je to jediné, co tenhle
 * produkt prodává, a slepě ji nikdo neporovnal. Vysoké úsilí proto platíme
 * tam, **odkud pochází 3D** (`architecture` píše geometrii a kulisu,
 * `objects` tvary a jejich umístění), a pravidla světa jedou nízko — ta jsou
 * graf událostí nad hotovým rejstříkem plánovače, ne prostorová úvaha.
 *
 * Tabulka je úplná nad `ChunkName`, takže nový kus bez rozhodnutí o úsilí
 * neprojde typovou kontrolou. Jiné požadavky (plánovač, celý kompilátor,
 * změna běžícího světa) žádný kus nenesou a jedou dál na úsilí z prostředí —
 * to je dnešní chování a tahle úloha na něj nesahá.
 */
export const CHUNK_EFFORT: Readonly<Record<ChunkName, Effort>> = {
  architecture: 'high',
  objects: 'high',
  rules: 'low',
  // Dvoukusý řez (P22 T16): `scene` je architektura i objekty naráz, tedy 3D.
  scene: 'high',
};

/**
 * **Úsilí po fázi, pro požadavky bez kusu (P21 T19).**
 *
 * Plánovač píše strukturu — rejstřík objektů a `sceneSpec` — ne geometrii.
 * Doměření 19. 9. 2026 (`evals/worldstream/planner-anatomy.json`) ukázalo, že
 * jeho 75–80 s je délka odpovědi (6,8 kB, z toho 79 % `sceneSpec`), ne
 * uvažování; nižší úsilí je tedy levný pokus, který T21 změří **spolu** se
 * štíhlým `sceneSpec` (T18) — artefakt T21 to připsání nerozdělí, protože
 * oddělené měření by stálo druhý živý běh. Kompilátor a změna běžícího světa
 * (`refine`) tu záměrně chybí: jedou dál na úsilí z prostředí, protože
 * z nich pochází 3D.
 */
export const STAGE_EFFORT: Readonly<Partial<Record<NonNullable<ReturnType<typeof requestStage>>, Effort>>> = {
  planner: 'low',
};

/**
 * Úsilí pro jedno volání. Rozhoduje **požadavek**, ne volající: kus i fáze se
 * čtou z textu (`requestChunk`, `requestStage`), takže přiřazení platí i na
 * cestě, která si o něj neřekla — přehrání archivu, opravné kolo, cokoli
 * dalšího. Kus má přednost před fází; požadavek bez obojího jede z prostředí.
 */
export function effortForCall(call: GenerationCall, config: UpstreamConfig): Effort {
  const chunk = requestChunk(call.request);
  if (chunk !== null) return CHUNK_EFFORT[chunk];
  const stage = requestStage(call.request);
  return (stage === null ? undefined : STAGE_EFFORT[stage]) ?? config.effort;
}

/**
 * Profil z prostředí. Neznámá hodnota je `null`, tedy **odmítnutá konfigurace**.
 *
 * Tichá náhrada by tady byla drahá oběma směry: překlep spadlý na `api` by
 * u předplatného vyžadoval cenu, která neexistuje, a překlep spadlý na
 * `subscription` by u placeného klíče **odpojil dolarový strop**. Nenastavená
 * proměnná je `api` — to je ta přísnější z těch dvou a je to dnešní chování.
 * `metered` (P30A) je jiné jméno pro `api`: metrovaná cesta po tokenech.
 */
function profileFrom(raw: string | undefined): UpstreamProfile | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'metered') return 'api';
  return value === 'api' || value === 'subscription' ? value : null;
}

/** Celé kladné číslo, nebo `null`. Prázdná i vadná hodnota je `null`. */
function wholePositive(raw: string | undefined): number | null {
  const parsed = Number((raw ?? '').trim());
  if ((raw ?? '').trim() === '') return null;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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

  const profile = profileFrom(env.WORLDSMITH_MODEL_PROFILE);
  if (profile === null) return null;

  // **U předplatného je povinný strop na POČET volání, ne cena.** Je to táž
  // doktrína jako u chybějící ceny o kus níž — mez, kterou nikdo nenastavil,
  // je nekonfigurace, ne nula — jen posunutá tam, kde ta mez doopravdy je.
  // `preflight.ts` to u profilu `subscription` dělá od P11 (`NO_CALL_CAP`);
  // produkt to do 9. 9. 2026 neuměl a `WORLDSMITH_SPEND_CAP_USD` tam vypadal
  // jako strop, který nedrží nic.
  //
  // U `api` se tady nevyžaduje: tam meze drží dolary a `spend-cap.ts` má
  // vlastní `DEFAULT_CALL_CAP` jako druhou pojistku proti špatně opsanému
  // ceníku.
  const callCap = profile === 'subscription' ? wholePositive(env.WORLDSMITH_CALL_CAP) : null;
  if (profile === 'subscription' && callCap === null) return null;

  // `positiveNumber` by tu nestačila: ta vadnou hodnotu tiše nahradí náhradou,
  // a náhrada za cenu je právě ta nula, která strop vypíná.
  const usdPerMTokOut = Number(env.WORLDSMITH_USD_PER_MTOK_OUT);
  if (!Number.isFinite(usdPerMTokOut) || usdPerMTokOut <= 0) return null;

  const maxOutputTokens = positiveNumber(env.WORLDSMITH_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
  // **`> 0` na ceně samotné nestačí — podtečení plovoucí čárkou** (P15 T29).
  // `5e-324` je konečné i kladné, takže podmínkou nad tímhle řádkem projde,
  // ale `(8000 × 5e-324) / 1e6` je **přesně nula**. Nejhorší případ pak vyjde
  // nula, `reserve(0)` projde i při stropu nula a volání se ani nezapočítá
  // (počítá se jen `worstCaseUsd > 0`, viz `spend-cap.ts`) — strop je zpátky
  // dekorace, přesně jako při chybějící ceně.
  //
  // Soudí se **součin**, ne cena: podtečení je vlastnost té dělenky, ne
  // jednoho čísla, takže jakákoli mez na ceně samotné by byla hádání.
  // A odmítá se tady, při stavbě větve, ne v `reserve()`: nekonfigurace má
  // vypnout živou větev, ne vyrábět odmítnutí na každém požadavku.
  if ((maxOutputTokens * usdPerMTokOut) / 1_000_000 <= 0) return null;

  const fallback = fallbackConfigFromEnv(env);
  return {
    ...(fallback === null ? {} : { fallback }),
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
    maxOutputTokens,
    timeoutMs: positiveNumber(env.WORLDSMITH_UPSTREAM_TIMEOUT_MS, endpoint === CODEX_CLI_ENDPOINT ? DEFAULT_CLI_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
    profile,
    callCap,
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
    generate: (call, signal) => generate(call, config, fetchImpl, signal),
  };
}

function worstCaseUsd(call: GenerationCall, config: UpstreamConfig): number {
  // Jeden token na znak. Viz hlavička souboru: je to strop, o který se opírá
  // ořez v `SpendCap.release()`, ne odhad průměru.
  const inputTokens = call.request.system.length + call.request.user.length;
  return (
    (inputTokens * config.pricing.usdPerMTokIn + config.maxOutputTokens * config.pricing.usdPerMTokOut) /
    1_000_000
  );
}

/**
 * **JSON s jednou závorkou navíc nebo méně na konci se přečte, ne zahodí.**
 *
 * Naměřeno 13. 9. 2026 (`evals/worldstream/latency-report.json`): `gpt-5.6-terra`
 * zavíral asi polovinu plannerových odpovědí o `}` navíc a `gpt-5.6-luna`
 * část compilerových o `}` méně — jinak správný dokument za 25–60 s a tisíce
 * tokenů, který by tahle brána vyhodila jako `MALFORMED_RESPONSE`, a věta by
 * porotci nevznikla vůbec. Opravuje se **jen konec dokumentu a nanejvýš o dvě
 * závorky**: zbytek textu se nesmí změnit, takže cokoli uprostřed (chybějící
 * čárka, useknutý řetězec) se dál odmítá tak, jak je.
 */
export function parseAnswerText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (thrown) {
    const trimmed = text.trimEnd();
    const closers = missingClosers(trimmed);
    const candidates = [
      ...(closers !== null && closers.length > 0 && closers.length <= 2 ? [trimmed + closers] : []),
      ...(trimmed.endsWith('}') ? [trimmed.slice(0, -1)] : []),
      ...(trimmed.endsWith('}}') ? [trimmed.slice(0, -2)] : []),
    ];
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        // další kandidát
      }
    }
    throw thrown;
  }
}

/**
 * Závorky, které na konci chybí, v pořadí, v jakém se mají dopsat; `null`,
 * když se text zavře dřív, než skončí (závorka navíc), nebo skončí v řetězci.
 */
function missingClosers(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return null;
    }
  }
  return inString ? null : stack.reverse().join('');
}

function usageOf(payload: unknown): Usage | null {
  const usage = (payload as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage;
  if (typeof usage?.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;
  // **Záporná složka (a `NaN`) je nečitelná účtenka, ne sleva.** `costUsd()`
  // obě složky **sčítá**, takže dost záporný vstup zaplatí kladný výstup a
  // součet vyjde těsně nad nulou, kde ho `release()` přijme jako poctivou
  // cenu: `{-1249, 250}` nad textem o 3000 znacích se zaúčtovalo 0,000005 USD
  // proti rezervaci 0,219505 USD, tedy **44 000× méně**. `!(x >= 0)` chytá
  // i `NaN`.
  //
  // **Bydlí to tady, ne u čtenáře textu**, a to je oprava z 1. 9. 2026: první
  // znění sedělo v `readableUsage()`, kterou `generate()` volá jen na dvou
  // návratech nesoucích text. Třetí návrat („odpověď nenese textový blok")
  // předával účtenku syrovou, takže tatáž otrávená dvojice byla přes
  // `MALFORMED_RESPONSE` **levnější než neposlat nic** (0,000005 proti
  // rezervaci, kterou jinak `BILLED_ON_FAILURE` na téhle příčině účtuje).
  // Naměřeno nezávislou revizí nad commitem `df4a6b5`.
  //
  // **Nekonečno se tu naopak schválně NEODMÍTÁ.** Zkusilo se to 21. 8. 2026
  // a bylo to horší; dnes už `null` zadarmo neúčtuje (`pipeline.ts` na něj
  // strhne rezervaci), ale `Infinity` se stejně dostane na tutéž rezervaci
  // přes `costUsd()` → `release()`, takže by změna nekoupila nic a jen by
  // zahodila jediné číslo, které o té odpovědi ven jde.
  if (!(usage.input_tokens >= 0) || !(usage.output_tokens >= 0)) return null;
  // **Dvojitá nula je nečitelná účtenka, ne volání zdarma — a platí to na
  // všechny tři návraty `generate()`, ne jen na ty dva s textem.** Rozhodnuto
  // 3. 9. 2026, rozpad hned pod touhle funkcí v „Rovnost na (0,0)".
  if (usage.input_tokens === 0 && usage.output_tokens === 0) return null;

  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

/**
 * ## Rovnost na (0, 0) bydlí v `usageOf()`, ne u textových návratů
 *
 * ⚠ **Tohle je rozhodnutý spor, ne aktuální stav — dvě nezávislé revize
 * 1. 9. 2026 si přímo protiřečily a obě měly pravdu o svém směru.** Zapsané je
 * to proto, aby se pravidlo nestěhovalo potřetí.
 *
 * **Proti přesunu** (revize nad `4a8952d`): dokud rovnost bydlela nahoře,
 * odpověď 200 s prázdným `content` a vynulovanou spotřebou zaplatila **celou
 * rezervaci** (0,2195 USD proti 0,00003 USD u téže vady s účtenkou `{1,1}`),
 * takže bránou, kterou nikdo nehlídá, jde strop 5 USD vyčerpat asi
 * **23 odpověďmi** bez jediného dolaru skutečné spotřeby — a nasazené demo pak
 * každému dalšímu porotci odpoví 429.
 *
 * **Pro přesun** (kontrolní revize téhož dne): ten argument **nerozlišuje ty
 * dvě podoby**, protože tutéž rezervaci účtuje odpověď bez pole `usage`
 * **už dnes** — `BILLED_ON_FAILURE.MALFORMED_RESPONSE` je `'estimate'`
 * (`./pipeline.ts:119–127`, strháváno na `./pipeline.ts:244–246`). Vyčerpat
 * strop tou branou tedy jde tak jako tak, a **levněji**: stačí `usage`
 * vynechat. Co zůstává, je jediná věc — **sleva za otrávené číslo**: `{0,0}`
 * na návratu „odpověď nenese textový blok" se účtovalo 0,00000000 USD proti
 * rezervaci 0,2585 USD, tedy asi **8600× levněji než neposlat účtenku vůbec**.
 *
 * **Vybraná strana je ta přísná, a rozhodl o tom rozdíl v pojistkách.**
 * Podúčtování nemá druhou obranu: `settle()` dostane poctivě vypadající nulu,
 * strop se nehne a nikdo se nic nedozví. Vyčerpání stropu ji má, je zapsaná
 * a je to počítadlo volání (`T9-capcoldstart`). Levnější cesta k témuž
 * vyčerpání navíc zůstává otevřená, takže se tímhle pravidlem nic nového
 * neotevírá.
 *
 * **Námitka první revize tím nepadá a nesmí se zamlčet:** nepoctivý
 * poskytovatel dolarový strop opravdu vyčerpá a demo pak odmítá. Odpověď na to
 * je počítadlo volání, ne sleva za nečitelnou účtenku.
 *
 * ⚠ **Samo o sobě to ale nestačilo, a je to změřené** — nález nezávislé revize
 * 3. 9. 2026, `VERDICT: routed`. Rovnost je pořád jen **bod**, a soused ho
 * obejde: na návratu bez textového bloku se `{0, 1}` účtovalo 0,000025 USD
 * a `{1, 0}` 0,000005 USD, tedy asi 10 000× a 50 000× levněji než mlčet. Ten
 * návrat proto od téhož dne zahazuje účtenku **celou** (`usage: null`, viz
 * `generate()` níž), protože bez textu se ověřit nedá žádná. Tohle pravidlo
 * tím rozhoduje už jen o dvou návratech s textem, kde na ně navazuje hranice
 * zdola — **zůstává ale tady, a ne u nich**, protože dvojitá nula je vlastnost
 * účtenky, ne toho návratu, který ji zrovna použije.
 *
 * **Hranice zdola se nepřesouvá a nemá kam:** odvozuje se z délky textu
 * (`FLOOR_CHARS_PER_TOKEN`), a na návratu bez textového bloku žádný text není.
 * Zůstává proto v `readableUsage()` níž.
 */

/**
 * **Hranice zdola** pro odpověď, která nese text.
 *
 * Dvojitá nula sem už nepatří — od 3. 9. 2026 bydlí o patro výš, v `usageOf()`,
 * a proč, je v bloku nad touhle funkcí. Zbývá to, co se z textu odvodit dá
 * a bez textu nedává smysl.
 *
 * ## Hranice byla druhá půlka téhož, protože rovnost byla bod, ne mez
 *
 * Dvojitá nula sama je jen jediný zakázaný bod v celém prostoru účtenek a
 * **poskytovatel nebo brána, která podhlásí o jeden token, ji obejde celou**:
 * `{0, 1}` se při ceníku 3/15 zaúčtuje 0,000025 USD, tedy 7300× levněji než
 * sousední `{0, 0}`, a dál se hne jen počítadlo volání — které se na serverless
 * resetuje s chladným startem. Naměřeno nezávislou revizí 1. 9. 2026.
 *
 * Hranice se proto **odvozuje z textu, který ta odpověď doopravdy nese**: kolik
 * výstupních tokenů si vůbec lze pro tolik znaků představit
 * (`FLOOR_CHARS_PER_TOKEN`). Jen výstup — vstup se legitimně cachuje, takže
 * `{0, 900}` je poctivá účtenka a musí se jí dál účtovat; hranice patří **pod**
 * ni. Konstanta v dolarech by tu byla špatná odpověď: ceník je konfigurace a
 * cenu z tokenů dělá až `costUsd()` nad `pricing` té větve.
 *
 * **Zvedá se, nikdy nesanuje — a to se soudí podle účtu, ne podle pole.**
 * Záporná, `NaN` i nekonečná účtenka projde beze změny: ty už si `release()`
 * v `./spend-cap.ts` účtuje celou rezervací, což je dražší než hranice.
 * Podmínka proto sahá i na **vstup**, přestože hranici dostává jen výstup —
 * naměřeno toutéž revizí, že bez toho `{-1, 0}` spadne z 0,2195 na 0,0062 USD
 * (35×) a `{-1000, 3}` na 0,0013 USD (176×): záporná složka totiž stlačovala
 * součet pod nulu, kde ho `release()` odmítal, a zvednutý výstup ho vrátil nad
 * nulu, kde ho přijme. Zlevnění otrávené účtenky je regrese směrem k penězům,
 * i když se pole, které se mění, jen zvedá.
 * Vedlejším účinkem hranice padá i `{n, 0}`, které dřív účtovalo jen vstup.
 *
 * ## Záporná složka je nečitelná účtenka, ne rozdíl
 *
 * Rovnost na (0, 0) a hranice zdola sahají obě jen na **jedno** ze dvou polí,
 * která `costUsd()` sčítá. Účtenku, jejíž jedna složka je záporná, tím ani
 * jedna z nich nezavírá: `{-1249, 250}` nad textem o 3000 znacích má výstup
 * přesně na hranici (250), takže hranice nespustí, a záporný vstup pak celý
 * součet stlačí na 0,000005 USD — **44 000× pod rezervaci 0,2195 USD**, a
 * `release()` to jako kladné konečné číslo přijme. Naměřeno nezávislou revizí
 * 1. 9. 2026; vada je starší než hranice, ta ji jen nezavřela.
 *
 * Kterákoli záporná složka proto padá na `null`, tedy na rezervaci — ale
 * **rozhoduje se to o patro výš, v `usageOf()`**, a to je oprava téhož dne.
 * Když pravidlo bydlelo tady, chránilo jen dva ze tří návratů `generate()`:
 * třetí („odpověď nenese textový blok") sem nikdy nedojde a předával účtenku
 * syrovou. U `release()` naopak bydlet nemůže — ten soudí jednu částku a ta je
 * v tomhle případě legitimně kladná; rozpad na složky vidí jen tenhle soubor.
 * Tahle funkce proto od té chvíle dostává zaručeně nezáporné složky.
 *
 * ## Co tím zavřít NEJDE
 *
 * **Délku textu volí poskytovatel**, takže dvouznakový textový blok srazí
 * hranici na jediný token a účtenka `{0, 1}` je pak od hranice k nerozeznání.
 * Proti nepoctivému poskytovateli dolarový strop neplatí nikdy — platí jen
 * počítadlo volání, a to se na serverless resetuje s chladným startem
 * (`T9-capcoldstart`). Hranice je obrana proti podhlášení, ne proti lhaní; tak
 * se o ní musí i mluvit.
 *
 * **Používá se na obou návratech, kde text existuje**, ne jen na tom úspěšném —
 * druhý nález téže revize. Kritérium je „odpověď nese text", takže i vadný JSON
 * uvnitř textového bloku sem patří; jinak by zbyla zrcadlová díra téhož tvaru,
 * kterou tahle funkce vznikla zavřít (naměřeno: strop 5 USD se nehne, běh
 * omezuje jen počítadlo volání, tedy až ~44 USD skutečné nejhorší útraty).
 */
function readableUsage(usage: Usage | null, text: string, maxOutputTokens: number): Usage | null {
  if (usage === null) return null;
  // Dvojitá nula sem už nedojde — od 3. 9. 2026 ji na `null` sráží `usageOf()`,
  // aby to platilo i na návratu bez textového bloku. Zdejší podmínka by od té
  // chvíle byla nedosažitelná, takže tu není; pořadí proti hranici níž drží
  // to, že `usageOf()` běží dřív.
  // Delší text, než na kolik se rezervovalo, znamená poskytovatele, který
  // ignoroval `max_tokens`. Hranice z něj nesmí vyrůst nad výstupní půlku
  // rezervace — jinak se strhne víc, než se na to volání drželo.
  const floorTokens = Math.min(Math.ceil(text.length / FLOOR_CHARS_PER_TOKEN), maxOutputTokens);
  // `< floorTokens` vyřadí nekonečno; záporná čísla a `NaN` zastavil `usageOf()`.
  // Nesmyslná účtenka tak projde dál nedotčená a zaplatí rezervaci, dražší.
  if (usage.outputTokens < floorTokens) return { inputTokens: usage.inputTokens, outputTokens: floorTokens };
  return usage;
}

/**
 * Co spustit. Na Windows se `codex.cmd` z Node bez shellu nespustí, takže se
 * volá přímo skript npm instalace přes tenhle `node`; jinde stačí `codex`
 * z PATH. `WORLDSMITH_CODEX_JS` to přebije pro stroj s jinou instalací.
 */
function codexCommand(): { readonly file: string; readonly prefix: readonly string[] } {
  const script = process.env.WORLDSMITH_CODEX_JS ?? (process.platform === 'win32'
    ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    : '');
  return script === '' ? { file: 'codex', prefix: [] } : { file: process.execPath, prefix: [script] };
}

/**
 * Tvrdost převzatá z mostu `scripts/codex-shim.mjs` (revize před `/ship`
 * 15. 9. 2026, `ship-codexcli`) – tytéž tři meze, tytéž seznamy:
 *
 * - **prostředí z allowlistu.** Codex dřív dědil celé prostředí serveru, tedy
 *   i `WORLDSMITH_MODEL_KEY` a token KV;
 * - **prázdný dočasný adresář** místo kořene repozitáře s interními dokumenty
 *   a `.env.local`, a `--ignore-rules` spolu s vypnutými nástroji;
 * - **vlastní časovač zabíjí celý strom.** `codex.js` spouští nativní binárku
 *   jako dítě a timeout `execFile` zabil jen obal – codex dál pálil předplatné.
 */
const CODEX_ENV_ALLOWLIST = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'CODEX_HOME'];

const CODEX_TOOL_SWITCHES = [
  'view_image', 'image_generation', 'code_mode_host', 'multi_agent', 'browser_use', 'computer_use', 'plugins', 'goals',
  'hooks', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'skill_search', 'skill_mcp_dependency_install', 'sleep_tool', 'unified_exec',
].flatMap((feature) => ['-c', `features.${feature}=false`]);

const MAX_CODEX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Jak dlouho se po zabití čeká na `close`, než se skončí bez něj. */
const CODEX_KILL_GRACE_MS = 2_000;

/** Soubor se schématem odpovědi leží v prázdném pracovním adresáři volání. */
export const CODEX_SCHEMA_FILE = 'answer-schema.json';

export function codexArgs(model: string, effort: string, cwd: string, withSchema = false): string[] {
  return [
    'exec',
    // Přepínač patří podpříkazu `exec` – před ním codex skončí kódem 2 (naměřeno 23. 9.).
    // Tiše ho ignoruje, když má zapnuté nástroje nebo MCP (openai/codex#15451); tady jsou
    // vypnuté všechny a `--ignore-user-config` drží MCP venku.
    ...(withSchema ? ['--output-schema', join(cwd, CODEX_SCHEMA_FILE)] : []),
    '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-c', 'approval_policy="never"', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
    '-c', `model_reasoning_effort="${effort}"`,
    '-c', 'features.shell_tool=false', '-c', 'features.apps=false', '-c', 'web_search="disabled"',
    ...CODEX_TOOL_SWITCHES,
    '--cd', cwd, '--model', model, '--json', '-',
  ];
}

/**
 * Na Windows `taskkill /T` přes PID obalu, **jen dokud obal žije**; jinde celá
 * skupina procesů. `afterKill` zavírá roury **až po doběhnutí `taskkill`**.
 *
 * Po `exit` obalu Windows jeho PID uvolní a smí ho dostat cizí proces, takže
 * `taskkill /F` by zabil něco, co nám nepatří (`ship-pidreuse`, revize
 * 15. 9. 2026). Proto ani roury nejdou zavřít dřív: zavřená roura sama obal
 * ukončí, a `taskkill`, který PID vyhledá o desítky milisekund později, by
 * trefil uvolněné číslo (security-reviewer před `/ship` 15. 9. 2026). Sirotka
 * za mrtvým obalem ten PID stejně nenajde – s ním se vypořádají zavřené roury
 * a lhůta ve `stop`. ID skupiny na POSIXu se neuvolní, dokud v ní někdo žije,
 * takže tam se zabíjí dál.
 */
export function killCodexTree(child: ChildProcess, afterKill: () => void): void {
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null)
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => afterKill());
    else afterKill();
  } else {
    try {
      process.kill(-(child.pid ?? 0), 'SIGKILL');
    } catch {
      /* skupina už neexistuje */
    }
    afterKill();
  }
}

function runCodex(model: string, effort: string, input: string, timeoutMs: number, schema?: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<string> {
  const command = codexCommand();
  const cwd = mkdtempSync(join(tmpdir(), 'worldsmith-codex-'));
  if (schema !== undefined) writeFileSync(join(cwd, CODEX_SCHEMA_FILE), JSON.stringify(schema));
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.prefix, ...codexArgs(model, effort, cwd, schema !== undefined)], {
      cwd,
      // Přetypování jen kvůli typu Next, který v `ProcessEnv` vyžaduje `NODE_ENV`.
      env: Object.fromEntries(CODEX_ENV_ALLOWLIST.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])) as NodeJS.ProcessEnv,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    // Buffery, ne řetězec: znak UTF-8 rozdělený mezi dvě čtení roury by se
    // po kouscích dekódoval na U+FFFD (revize 15. 9. 2026, naměřeno 6 z 7 hranic).
    const chunks: Buffer[] = [];
    // Totéž platí pro stderr: jméno uživatele s diakritikou rozdělené mezi dvě
    // čtení by dostalo U+FFFD a redakce archivu by ho nepoznala.
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let outputBytes = 0;
    let cut: string | null = null;
    let done = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const stop = (why: string) => {
      // Jen jednou: roury se zavírají až po `taskkill`, takže data mezitím tečou
      // dál a každý další kus nad 8 MiB by pouštěl další `taskkill`.
      if (cut !== null) return;
      cut = why;
      // Na obal, který už skončil, se `taskkill` neposílá, a `close` pak nepřijde,
      // dokud rouru drží potomek, který ho přežil. Roury se proto zavřou a po
      // krátké lhůtě se končí i bez `close` – odpověď ani adresář na sirotkovi
      // viset nesmí (revize 15. 9. 2026).
      killCodexTree(child, () => {
        child.stdout.destroy();
        child.stderr.destroy();
      });
      grace = setTimeout(() => finish(null), CODEX_KILL_GRACE_MS);
    };
    const timer = setTimeout(() => stop('codex exec ran past the timeout'), timeoutMs);
    const cancel = () => stop('the call was cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted === true) cancel();
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CODEX_OUTPUT_BYTES) stop('codex exec wrote more than 8 MiB');
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 1200) return;
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);

    // `close`, ne `exit`: přijde, až pustí roury celý strom, takže adresář se
    // maže a odpověď vrací po doložitelném konci, ne po smrti obalu.
    const finish = (failure: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', cancel);
      try {
        // Na Windows drží adresář ještě chvíli dozabíjený proces (EBUSY).
        rmSync(cwd, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        /* prázdný adresář v tmp nikomu neublíží */
      }
      const reason = cut ?? failure;
      if (reason === null) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(`${reason} ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 300)}`.trim()));
    };
    child.on('error', (error) => finish(error.message.split('\n')[0]));
    child.on('close', (code) => finish(code === 0 ? null : `codex exec exited with code ${code}`));
  });
}

async function generateViaCodexCli(call: GenerationCall, config: UpstreamConfig, signal?: AbortSignal): Promise<GenerationOutcome> {
  let output: string;
  try {
    output = await observePhaseAsync(serverPhaseObserver, 'provider-http-request', () => runCodex(
      config.model,
      effortForCall(call, config),
      `${call.request.system}\n\n${call.request.user}`,
      config.timeoutMs,
      call.request.outputSchema,
      signal,
    ));
  } catch (thrown) {
    return { ok: false, reason: 'UPSTREAM_UNAVAILABLE', detail: `the codex call did not complete: ${(thrown as Error).message}`, usage: null };
  }

  let events: Record<string, any>[];
  try {
    events = output.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, any>);
  } catch (thrown) {
    return { ok: false, reason: 'MALFORMED_RESPONSE', detail: `the codex event stream is not JSON lines: ${(thrown as Error).message}`, usage: null };
  }
  const failed = events.find((event) => event.type === 'turn.failed' || event.type === 'error');
  if (failed !== undefined)
    return { ok: false, reason: 'UPSTREAM_REJECTED', detail: `codex refused the turn: ${JSON.stringify(failed).slice(0, 300)}`, usage: null };
  const completion = events.find((event) => event.type === 'turn.completed');
  const message = [...events].reverse().find((event) => event.type === 'item.completed' && event.item?.type === 'agent_message');
  const text: unknown = message?.item?.text;
  if (completion === undefined || typeof text !== 'string')
    return { ok: false, reason: 'MALFORMED_RESPONSE', detail: 'the codex turn carries no completed message', usage: null };

  const usage = usageOf({ usage: completion.usage });
  let body: unknown;
  try {
    body = observePhase(serverPhaseObserver, 'provider-output-json-parse', () => parseAnswerText(text));
  } catch (thrown) {
    return {
      ok: false,
      reason: 'MALFORMED_RESPONSE',
      detail: `the codex answer is not JSON: ${(thrown as Error).message}`,
      usage: readableUsage(usage, text, config.maxOutputTokens),
      raw: text,
    };
  }
  return {
    ok: true,
    body,
    usage: readableUsage(usage, text, config.maxOutputTokens),
    provenance: { branch: UPSTREAM_BRANCH_ID, source: 'codex-cli', synthetic: false, model: config.model },
  };
}

/** Timeout volání, a když přijde `signal`, i jeho zrušení. */
function withCancel(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  return signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]);
}

/**
 * Stavy, u kterých poskytovatel nás, ne požadavek: špatný klíč, vyčerpaný limit
 * nebo kredit. Pro režiséra je to výpadek modelu (záloha smí převzít), ne vadná
 * věta – proto `UPSTREAM_UNAVAILABLE` jako 5xx, ostatní 4xx zůstávají odmítnutím.
 */
const REFUSED_US: Readonly<Record<number, string>> = {
  401: 'the key was refused',
  403: 'the key was refused',
  429: 'rate limited or out of credit',
};

/**
 * OpenAI chat API pro llama.cpp (`llamacpp:`) i hostovaného poskytovatele
 * (`openai:`). Liší se tím, co hostovaný poskytovatel navíc chce: povinný klíč,
 * `reasoning_effort` a u OpenAI API `max_completion_tokens`.
 */
async function generateViaChat(call: GenerationCall, config: UpstreamConfig, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<GenerationOutcome> {
  const hosted = config.endpoint.startsWith(OPENAI_PREFIX);
  const name = hosted ? 'hosted' : 'llama.cpp';
  const root = config.endpoint.slice(hosted ? OPENAI_PREFIX.length : LLAMACPP_PREFIX.length).replace(/\/+$/, '');
  const schema = call.request.outputSchema;
  const format = schema === undefined ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } };
  const messages = [
    { role: 'system', content: call.request.system },
    { role: 'user', content: call.request.user },
  ];
  // Rozumující modely OpenAI API `max_tokens` i jinou teplotu než výchozí odmítnou
  // čtyřistovkou; ostatní poskytovatelé dokumentují `max_tokens`. Teplota se
  // hostovanému poskytovateli neposílá – gpt-oss ji doporučuje nechat výchozí.
  const tokenField = hosted && new URL(root).hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
  const body = hosted
    ? { model: config.model, [tokenField]: config.maxOutputTokens, reasoning_effort: effortForCall(call, config), messages, response_format: format }
    : { model: config.model, max_tokens: config.maxOutputTokens, temperature: 0, messages, response_format: format };
  let response: Response;
  try {
    response = await observePhaseAsync(serverPhaseObserver, 'provider-http-request', () => fetchImpl(`${root}/v1/chat/completions`, {
      method: 'POST',
      headers: config.apiKey === '' ? { 'content-type': 'application/json' } : { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: withCancel(config.timeoutMs, signal),
    }));
  } catch (thrown) {
    const error = thrown as Error;
    const why = error.name === 'TimeoutError' ? `timed out after ${String(config.timeoutMs)} ms` : error.message;
    return { ok: false, reason: 'UPSTREAM_UNAVAILABLE', detail: `the ${name} call did not complete: ${why}`, usage: null };
  }
  if (!response.ok) {
    const refused = REFUSED_US[response.status];
    return {
      ok: false,
      reason: response.status >= 500 || refused !== undefined ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_REJECTED',
      detail: `upstream answered ${response.status}${refused === undefined ? '' : `: ${refused}`}`,
      usage: null,
    };
  }

  let payload: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
  try {
    payload = (await observePhaseAsync(serverPhaseObserver, 'provider-response-json', () => response.json())) as typeof payload;
  } catch (thrown) {
    return { ok: false, reason: 'MALFORMED_RESPONSE', detail: `the ${name} answer is not JSON: ${(thrown as Error).message}`, usage: null };
  }
  const choice = payload?.choices?.[0];
  // Jen `content`: gpt-oss přes API vrací vedle něj uvažování (`reasoning`,
  // `reasoning_content`), a to je úvaha, ne odpověď – ani když `content` chybí.
  const text = choice?.message?.content;
  if (typeof text !== 'string') return { ok: false, reason: 'MALFORMED_RESPONSE', detail: `the ${name} answer carries no message`, usage: null };

  // `completion_tokens` zahrnuje i tokeny uvažování, takže cena je celá.
  const usage = readableUsage(usageOf({ usage: { input_tokens: payload.usage?.prompt_tokens, output_tokens: payload.usage?.completion_tokens } }), text, config.maxOutputTokens);
  // Useknutá odpověď se nedoplňuje, stejně jako na cestě Messages.
  const truncated = choice?.finish_reason === 'length';
  let answer: unknown;
  try {
    answer = observePhase(serverPhaseObserver, 'provider-output-json-parse', () => (truncated ? JSON.parse(text) : parseAnswerText(text)));
  } catch (thrown) {
    return { ok: false, reason: 'MALFORMED_RESPONSE', detail: `the ${name} text is not JSON${truncated ? ' (cut at max_tokens)' : ''}: ${(thrown as Error).message}`, usage, raw: text };
  }
  return { ok: true, body: answer, usage, provenance: { branch: UPSTREAM_BRANCH_ID, source: hosted ? 'hosted-http' : 'llamacpp-http', synthetic: false, model: config.model } };
}

async function generate(
  call: GenerationCall,
  config: UpstreamConfig,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<GenerationOutcome> {
  if (config.endpoint === CODEX_CLI_ENDPOINT) return generateViaCodexCli(call, config, signal);
  if (config.endpoint.startsWith(LLAMACPP_PREFIX) || config.endpoint.startsWith(OPENAI_PREFIX)) return generateViaChat(call, config, fetchImpl, signal);
  let response: Response;
  try {
    response = await observePhaseAsync(serverPhaseObserver, 'provider-http-request', () => fetchImpl(config.endpoint, {
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
        output_config: { effort: effortForCall(call, config) },
        system: call.request.system,
        messages: [{ role: 'user', content: call.request.user }],
      }),
      signal: withCancel(config.timeoutMs, signal),
    }));
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
    payload = await observePhaseAsync(serverPhaseObserver, 'provider-response-json', () => response.json());
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
      // **Na tomhle návratu se účtenka zahazuje celá, ne jen dvojitá nula** —
      // nález nezávislé revize 3. 9. 2026, `VERDICT: routed`, změřeno.
      //
      // Rovnost na (0,0) v `usageOf()` zavřela **bod**, a soused ho obejde:
      // `{0, 1}` se tady účtovalo 0,000025 USD a `{1, 0}` 0,000005 USD proti
      // rezervaci 0,2585 USD, tedy asi 10 000× a 50 000× levněji než neposlat
      // účtenku vůbec. Je to týž „bod, ne mez", kvůli kterému má textová cesta
      // hranici zdola — jenže hranice se odvozuje z délky textu a **tady žádný
      // text není**, takže se tu žádná účtenka ověřit nedá.
      //
      // Zahodit ji nic nestojí: `runPipeline()` ji z neúspěšného výsledku
      // **ven nevydává** (`./pipeline.ts:247–255` nemá pole `usage`), takže
      // slouží výhradně k výpočtu účtu. Neověřitelná účtenka, která jen
      // zlevňuje, je přesně to, na co `BILLED_ON_FAILURE` je. Ostatní návraty
      // bez ověřitelného textu (`UPSTREAM_REJECTED`, `UPSTREAM_UNAVAILABLE`,
      // „není JSON") posílají `null` odjakživa; tenhle byl jediná výjimka.
      usage: null,
    };

  // **Useknutá odpověď se nedoplňuje** (`ship-testgaps`, 15. 9. 2026). Závorky,
  // které chybí po `stop_reason: max_tokens`, nejsou překlep modelu, ale konec,
  // který nikdy nepřišel – doplněný by z půlky světa udělal platný dokument.
  const truncated = (payload as { stop_reason?: unknown } | null)?.stop_reason === 'max_tokens';
  let body: unknown;
  try {
    body = observePhase(serverPhaseObserver, 'provider-output-json-parse', () => (truncated ? JSON.parse(text) : parseAnswerText(text)));
  } catch (thrown) {
    return {
      ok: false,
      reason: 'MALFORMED_RESPONSE',
      detail: `the upstream text block is not JSON${truncated ? ' (cut at max_tokens)' : ''}: ${(thrown as Error).message}`,
      // **Rozhoduje text, ne úspěch.** Sem se dojde jen s textovým blokem
      // v ruce, takže hranice zdola se z čeho odvodit má — a odvozuje se,
      // i když je odpověď vadná. Návrat výš text nemá, takže tam se účtenka
      // neověřuje vůbec a zahazuje se celá.
      usage: readableUsage(usage, text, config.maxOutputTokens),
      raw: text,
    };
  }

  return {
    ok: true,
    body,
    // NEsrážet na `{0, 0}`: `null` znamená „účtenku neumíme přečíst" a strop na
    // to musí účtovat rezervaci; nula by znamenala volání zdarma. Dvojitou nulu
    // na `null` sráží `usageOf()` výš, hranici zdola dodá `readableUsage()`.
    usage: readableUsage(usage, text, config.maxOutputTokens),
    provenance: {
      branch: UPSTREAM_BRANCH_ID,
      source: 'upstream-http',
      synthetic: false,
      model: config.model,
    },
  };
}
