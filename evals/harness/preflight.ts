/**
 * Preflight poskytovatele (T18) — poslední kontrola **před** prvním voláním.
 *
 * Do téhle chvíle celý plán běžel proti zmrazeným odpovědím a nestál nic
 * (`src/model/client.ts`, „v Phase 3 výhradně režim záznamu"). Za HALT bránou
 * se začíná volat doopravdy, a AC T18 na tenhle soubor klade jedinou, zato
 * tvrdou podmínku: **ověří credentials, model a zbývající strop dřív, než padne
 * první placené volání, a když kterékoli chybí, selže s jasnou chybou.**
 *
 * ## Proč to není jedna podmínka, ale seznam důvodů
 *
 * „Něco chybí" není jasná chyba. Chybějící klíč, model mimo allowlist a
 * vyčerpaný strop jsou tři různé situace s třemi různými nápravami, a člověk,
 * který běh spouští, potřebuje vědět kterou. Každý důvod proto má vlastní kód
 * i vlastní větu s návodem.
 *
 * ## Dva profily, a rozdíl mezi nimi není cena
 *
 * Rozhodnuto 14. 8. 2026: vývoj běží v rámci předplatného, API se šetří na
 * závěrečné produkční měření. Osa ale **není „kdo platí"** — je to *co ten běh
 * smí dokázat*:
 *
 * - `api` — metrované volání s tvrdým stropem v dolarech. **Jediný profil, ze
 *   kterého smí vzniknout kill gate report.**
 * - `subscription` — skutečný model přes lokální proxy, kterou platí
 *   předplatné. Slouží k ladění promptů a k důkazu, že model do gramatiky
 *   vůbec trefí. Číslo z něj **není** výsledek brány.
 *
 * Kdyby se ten rozdíl pojmenoval podle ceny, vznikne přesně past, před kterou
 * varuje `syntheticResponses.honestyClause` ve zmrazeném protokolu: levné číslo
 * se tiše stane tím číslem v reportu. Profil se proto razítkuje do artefaktu a
 * bránu hlídá `assertGateProfile` v `./live`, ne disciplína.
 *
 * ## Strop se u předplatného nesmí stát dekorací
 *
 * Přes předplatné se neúčtuje po voláních, takže `EVAL_SPEND_CAP_USD` by tam
 * nezadržel nic — a nominální strop, který nic nedrží, je horší než žádný,
 * protože se na něj někdo spolehne. Profil `subscription` proto strop v
 * dolarech **prohlásí za neplatný** a nahradí ho tvrdým stropem **počtu
 * volání**: zbloudilá vývojová smyčka narazí do zdi stejně, jen se ta zeď měří
 * v jiné jednotce.
 *
 * ## Allowlist modelů je jediné místo, kde smí identifikátor modelu vzniknout
 *
 * `plans/P8-odevzdani.md` T800 to žádá tvrdě, a `TOOLING.md` §2 to má jako
 * vedlejší efekt zploštěného IR (*„poskytovatel se stane vyměnitelným"*).
 * Model, který v `LIVE_MODELS` není, se nezavolá — a přidat ho je **vědomá
 * editace tohohle souboru**, ne překlep v proměnné prostředí. Profil je
 * vlastnost položky allowlistu, takže i přepnutí mezi předplatným a API je
 * vědomá volba jednoho jména, ne kombinace tří proměnných.
 *
 * ## Ceny se sem NEOPISUJÍ
 *
 * Strop v dolarech se dá vynutit jedině přes cenu za token, a ta se u
 * poskytovatele mění. Zapečená cena, která se rozejde se skutečnou, dělá ze
 * stropu dekoraci — počítal by se z nesprávného čísla a pustil by běh dál, než
 * měl. Cena proto přichází z prostředí, ze stejného souboru a od stejného
 * člověka jako strop sám: kdo zapisuje `EVAL_SPEND_CAP_USD`, má ceník
 * poskytovatele právě otevřený.
 *
 * ## Klíč se odsud nikdy nedostane ven
 *
 * `PreflightFailure.detail` ani `describeConfig()` nesmí nést hodnotu klíče.
 * Detail selhání končí v logu běhu a v `evals/live/<runId>/`, tedy na disku a
 * potenciálně v CI výstupu; klíč v něm je nález, ne diagnostika. Hlídá to
 * `evals/harness/__tests__/live.test.ts`.
 */

import type { UpstreamRequest } from '../../src/model/prompt';

// ---------------------------------------------------------------------------
// Allowlist — jediný zdroj identifikátorů modelu na živé cestě
// ---------------------------------------------------------------------------

/** Co ten běh smí dokázat. Viz hlavička — není to o ceně. */
export type ProviderProfile = 'api' | 'subscription';

/** Tvar požadavku, který ta URL přijímá. Rozhoduje o dopravě, ne o profilu. */
export type WireShape = 'openai-chat' | 'anthropic-messages';

export interface LiveModel {
  /** Klíč do allowlistu, jediná hodnota `EVAL_MODEL`. Unikátní napříč profily. */
  readonly id: string;
  /**
   * Jméno, které odejde na drát.
   *
   * Liší se od `id` tam, kde je tentýž model dostupný oběma cestami: selektor
   * musí být jednoznačný (`gpt-5.6-sol@proxy`), ale poskytovatel zná jen svoje
   * vlastní jméno (`gpt-5.6-sol`). Ukládá se to, co odešlo.
   */
  readonly wireModel: string;
  readonly provider: 'openai';
  readonly profile: ProviderProfile;
  readonly wire: WireShape;
  /** Úplná URL. Ne base + cesta složená jinde — složit se dá i něco jiného. */
  readonly url: string;
}

/**
 * Povolené modely živého běhu.
 *
 * **Rozhodnuto 14. 8. 2026: poskytovatel je OpenAI.** Ne volbou preference, ale
 * dostupností — uživatel jede na Max plánu, který dává Codex CLI, nikoli API
 * klíč. `TOOLING.md:35` tuhle cestu drží otevřenou přímo: zploštěné IR bylo
 * podmínkou Anthropic Structured Outputs, ne jejich výsadou, a *„běží i na
 * OpenAI"*.
 *
 * Položky `@proxy` míří na lokální `claude-code-proxy`, která předplatné
 * převléká za anthropicské API. **Adresa je `localhost` a je to podstatné:**
 * profil `subscription` nesmí umět zavolat placený endpoint, takže se ta dvě
 * URL nikde neskládají z base a cesty — každá je zapsaná celá.
 *
 * ⚠ **`EMISSION_MODEL` v `src/model/prompt.ts` je od 6. 9. 2026 `gpt-5.6-sol`,
 * ne `claude-opus-5`.** Do té chvíle tu stálo, že alias zůstává, protože
 * pojmenovává model zmrazeného korpusu — jenže `evals/frozen/responses/` jsou
 * syntetické odpovědi klíčované podle promptu, ne podle jména modelu, takže
 * zmrazený korpus tou změnou dotčený není a AC T2b platí dál. Skutečná cena
 * aliasu byla opačná: proxy vracela odpovědi `gpt-5.6-sol` **označené jako
 * `claude-opus-5`**, takže archiv i report zapisovaly nepravdu do dokumentu,
 * který jde do přihlášky. Rozhodnutí `G2` (a) ji ruší — žádá se přímo jménem.
 */
export const LIVE_MODELS: readonly LiveModel[] = [
  { id: 'gpt-5.6', wireModel: 'gpt-5.6', provider: 'openai', profile: 'api', wire: 'openai-chat', url: 'https://api.openai.com/v1/chat/completions' },
  { id: 'gpt-5.6-mini', wireModel: 'gpt-5.6-mini', provider: 'openai', profile: 'api', wire: 'openai-chat', url: 'https://api.openai.com/v1/chat/completions' },
  { id: 'gpt-5.6-sol', wireModel: 'gpt-5.6-sol', provider: 'openai', profile: 'api', wire: 'openai-chat', url: 'https://api.openai.com/v1/chat/completions' },
  { id: 'gpt-5.6-sol@proxy', wireModel: 'gpt-5.6-sol', provider: 'openai', profile: 'subscription', wire: 'anthropic-messages', url: 'http://localhost:18766/v1/messages' },
  { id: 'gpt-5.6-terra@proxy', wireModel: 'gpt-5.6-terra', provider: 'openai', profile: 'subscription', wire: 'anthropic-messages', url: 'http://localhost:18766/v1/messages' },
];

// ---------------------------------------------------------------------------
// Výsledek
// ---------------------------------------------------------------------------

export type PreflightReason =
  /** `OPENAI_API_KEY` chybí nebo je prázdný. Jen profil `api`. */
  | 'NO_CREDENTIALS'
  /** `EVAL_MODEL` není nastavený. */
  | 'NO_MODEL'
  /** `EVAL_MODEL` je nastavený, ale v `LIVE_MODELS` není. */
  | 'MODEL_NOT_ALLOWED'
  /** `EVAL_SPEND_CAP_USD` chybí. Jen profil `api`. */
  | 'NO_SPEND_CAP'
  /** Strop není konečné kladné číslo. */
  | 'INVALID_SPEND_CAP'
  /** Chybí cena za milion tokenů — strop by se neměl z čeho počítat. */
  | 'NO_PRICE'
  /** Cena není konečné nezáporné číslo. */
  | 'INVALID_PRICE'
  /** Strop je vyčerpaný — utraceno tolik co víc, než kolik bylo schváleno. */
  | 'CAP_EXHAUSTED'
  /** `EVAL_CALL_CAP` chybí. Jen profil `subscription`. */
  | 'NO_CALL_CAP'
  /** Strop počtu volání není celé kladné číslo. */
  | 'INVALID_CALL_CAP'
  /** Strop počtu volání je vyčerpaný. */
  | 'CALL_CAP_EXHAUSTED';

export interface PreflightFailure {
  readonly ok: false;
  readonly reason: PreflightReason;
  /** Věta pro člověka, který běh spouští. **Nikdy nenese hodnotu klíče.** */
  readonly detail: string;
}

interface ConfigBase {
  readonly ok: true;
  readonly model: LiveModel;
}

/** Metrovaný profil: tvrdý strop v dolarech, spočítaný z ceny za token. */
export interface ApiConfig extends ConfigBase {
  readonly profile: 'api';
  readonly metered: true;
  readonly apiKey: string;
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly remainingUsd: number;
  readonly usdPerMillionInput: number;
  readonly usdPerMillionOutput: number;
}

/**
 * Nemetrovaný profil: strop se měří v počtu volání.
 *
 * `metered: false` je tu proto, aby se cena nedala spočítat omylem —
 * `costUsd()` bere jen `ApiConfig`, takže překladač odmítne kód, který by u
 * předplatného utrácel dolary, místo aby to zjistil až člověk nad reportem.
 */
export interface SubscriptionConfig extends ConfigBase {
  readonly profile: 'subscription';
  readonly metered: false;
  readonly callCap: number;
  readonly callsMade: number;
  readonly callsRemaining: number;
}

export type LiveConfig = ApiConfig | SubscriptionConfig;

export type PreflightResult = LiveConfig | PreflightFailure;

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Kolik z rozpočtu už běh spotřeboval.
 *
 * Obě jednotky zvlášť a obě povinné. Jediné číslo „spotřebováno" by znamenalo,
 * že jeho význam určuje profil — a záměna dolarů za volání je chyba, kterou by
 * nic nechytlo.
 */
export interface Used {
  readonly usd: number;
  readonly calls: number;
}

const NOTHING_USED: Used = { usd: 0, calls: 0 };

const fail = (reason: PreflightReason, detail: string): PreflightFailure => ({ ok: false, reason, detail });

/** Prázdný a jen-bílé-znaky řetězec je „nenastaveno", ne „nastaveno na nic". */
function required(env: Env, name: string): string | null {
  const raw = env[name];
  return raw === undefined || raw.trim().length === 0 ? null : raw.trim();
}

/**
 * Ověří model, credentials a zbývající strop.
 *
 * **Model se čte první**, protože z něj plyne profil a teprve profil říká, které
 * další proměnné vůbec platí. Volá se jednou před prvním voláním (s nulami) a
 * pak před každým dalším (s dosavadní spotřebou), takže jediná funkce hlídá
 * obojí: že se běh vůbec smí rozjet, a že se v půlce zastaví.
 */
export function preflight(env: Env, used: Used = NOTHING_USED): PreflightResult {
  const modelId = required(env, 'EVAL_MODEL');
  if (modelId === null)
    return fail(
      'NO_MODEL',
      `EVAL_MODEL není nastavený. Povolené modely: ${LIVE_MODELS.map((model) => model.id).join(', ')}.`,
    );

  const model = LIVE_MODELS.find((candidate) => candidate.id === modelId);
  if (model === undefined)
    return fail(
      'MODEL_NOT_ALLOWED',
      `model ${modelId} není v allowlistu. Povolené: ${LIVE_MODELS.map((candidate) => candidate.id).join(', ')}. ` +
        'Přidat další je vědomá editace evals/harness/preflight.ts, ne změna prostředí.',
    );

  return model.profile === 'api' ? apiPreflight(env, model, used.usd) : subscriptionPreflight(env, model, used.calls);
}

function apiPreflight(env: Env, model: LiveModel, spentUsd: number): PreflightResult {
  const apiKey = required(env, 'OPENAI_API_KEY');
  if (apiKey === null)
    return fail(
      'NO_CREDENTIALS',
      'OPENAI_API_KEY není nastavený. Vlož ho ručně do .env.local — klíč z jiného projektu se sem nepřenáší.',
    );

  const capRaw = required(env, 'EVAL_SPEND_CAP_USD');
  if (capRaw === null)
    return fail('NO_SPEND_CAP', 'EVAL_SPEND_CAP_USD není nastavený. Bez schváleného stropu se placený běh nespouští.');

  const capUsd = Number(capRaw);
  if (!Number.isFinite(capUsd) || capUsd <= 0)
    return fail('INVALID_SPEND_CAP', `EVAL_SPEND_CAP_USD je "${capRaw}"; čekalo se konečné kladné číslo v dolarech.`);

  const prices: { readonly name: string; readonly value: number | null }[] = [
    { name: 'EVAL_USD_PER_MTOK_IN', value: priceOf(env, 'EVAL_USD_PER_MTOK_IN') },
    { name: 'EVAL_USD_PER_MTOK_OUT', value: priceOf(env, 'EVAL_USD_PER_MTOK_OUT') },
  ];
  for (const price of prices) {
    if (required(env, price.name) === null)
      return fail(
        'NO_PRICE',
        `${price.name} není nastavená. Strop v dolarech se bez ceny za token nedá vynutit; ` +
          'opiš ji z ceníku poskytovatele do .env.local vedle stropu.',
      );
    if (price.value === null)
      return fail('INVALID_PRICE', `${price.name} je "${String(env[price.name])}"; čekalo se konečné nezáporné číslo.`);
  }

  // **Cena výstupu musí být kladná.** Při nule vyjde nula i nejhorší možná
  // cena volání, rezerva před voláním nic nezadrží a strop je dekorace —
  // běh se protočí celý, zatímco poskytovatel účtuje. Cena vstupu nula
  // projít smí: rezervu drží strop výstupních tokenů.
  if (prices[1].value === 0)
    return fail(
      'INVALID_PRICE',
      'EVAL_USD_PER_MTOK_OUT je 0; při nulové ceně výstupu vyjde nula i rezerva a strop by nic nezadržel.',
    );

  const remainingUsd = capUsd - spentUsd;
  if (remainingUsd <= 0)
    return fail(
      'CAP_EXHAUSTED',
      `strop ${capUsd.toFixed(2)} USD je vyčerpaný (utraceno ${spentUsd.toFixed(4)} USD). Běh je neúplný, ne selhaný.`,
    );

  return {
    ok: true,
    profile: 'api',
    metered: true,
    model,
    apiKey,
    capUsd,
    spentUsd,
    remainingUsd,
    usdPerMillionInput: prices[0].value!,
    usdPerMillionOutput: prices[1].value!,
  };
}

/**
 * Předplatné: klíč se nečte a strop je v počtu volání.
 *
 * `OPENAI_API_KEY` se tu **vědomě ignoruje**, i když v prostředí je. Kdyby se
 * načetl „pro jistotu", nosila by ho konfigurace nemetrovaného běhu až do
 * dopravy, která ho nepotřebuje — a klíč, který se nikam nemusí dostat, se
 * nemá odkud uniknout.
 */
function subscriptionPreflight(env: Env, model: LiveModel, callsMade: number): PreflightResult {
  const capRaw = required(env, 'EVAL_CALL_CAP');
  if (capRaw === null)
    return fail(
      'NO_CALL_CAP',
      'EVAL_CALL_CAP není nastavený. Přes předplatné se neúčtuje po voláních, takže strop v dolarech by nezadržel nic; ' +
        'ohraničí se počet volání.',
    );

  const callCap = Number(capRaw);
  if (!Number.isInteger(callCap) || callCap <= 0)
    return fail('INVALID_CALL_CAP', `EVAL_CALL_CAP je "${capRaw}"; čekalo se celé kladné číslo volání.`);

  const callsRemaining = callCap - callsMade;
  if (callsRemaining <= 0)
    return fail(
      'CALL_CAP_EXHAUSTED',
      `strop ${callCap} volání je vyčerpaný (provedeno ${callsMade}). Běh je neúplný, ne selhaný.`,
    );

  return { ok: true, profile: 'subscription', metered: false, model, callCap, callsMade, callsRemaining };
}

function priceOf(env: Env, name: string): number | null {
  const raw = required(env, name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Útrata
// ---------------------------------------------------------------------------

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Cena jednoho volání. Ceny jsou za milion tokenů — proto ten dělitel.
 *
 * Bere **jen** `ApiConfig`. U předplatného žádná cena za token neexistuje a
 * dosadit tam nulu by znamenalo vyrobit číslo, které vypadá jako útrata.
 */
export function costUsd(usage: Usage, config: ApiConfig): number {
  return (
    (usage.inputTokens * config.usdPerMillionInput + usage.outputTokens * config.usdPerMillionOutput) / 1_000_000
  );
}

/**
 * Konfigurace k vypsání do logu a do `evals/live/<runId>/`.
 *
 * **Bez klíče.** Není to opatrnost navíc: běh se ukládá na disk a v CI se
 * vypisuje, takže cokoliv, co tahle funkce vrátí, je potenciálně veřejné.
 */
export function describeConfig(config: LiveConfig): string {
  const head = [`model=${config.model.id}`, `wire=${config.model.wireModel}`, `profile=${config.profile}`];
  const budget = config.metered
    ? [
        `cap=${config.capUsd.toFixed(2)}USD`,
        `spent=${config.spentUsd.toFixed(4)}USD`,
        `remaining=${config.remainingUsd.toFixed(4)}USD`,
        `price=${config.usdPerMillionInput}/${config.usdPerMillionOutput} per Mtok`,
      ]
    : [`cap=${config.callCap} calls`, `made=${config.callsMade}`, `remaining=${config.callsRemaining}`, 'usd=neplatné'];
  return [...head, ...budget].join(' ');
}

/**
 * Požadavek s **živým** jménem modelu.
 *
 * `buildEmissionRequest` plní `model` konstantou zmrazeného korpusu. Uložit
 * záznam s tím jménem by znamenalo tvrdit, že odpověděl model, který se
 * nezavolal — a přesně na tenhle druh záměny míří poznámka u T18 v plánu.
 * Dosazuje se `wireModel`, tedy jméno, které doopravdy odejde na drát.
 */
export function withLiveModel(request: UpstreamRequest, config: LiveConfig): UpstreamRequest {
  return { ...request, model: config.model.wireModel };
}
