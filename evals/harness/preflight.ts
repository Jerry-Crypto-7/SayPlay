/**
 * Preflight poskytovatele (T18) — poslední kontrola **před** prvním placeným
 * voláním.
 *
 * Do téhle chvíle celý plán běžel proti zmrazeným odpovědím a nestál nic
 * (`src/model/client.ts`, „v Phase 3 výhradně režim záznamu"). Za HALT bránou
 * se peníze začínají utrácet doopravdy, a AC T18 na tenhle soubor klade jedinou,
 * zato tvrdou podmínku: **ověří credentials, model a zbývající strop dřív, než
 * padne první placené volání, a když kterékoli chybí, selže s jasnou chybou.**
 *
 * ## Proč to není jedna podmínka, ale pět důvodů
 *
 * „Něco chybí" není jasná chyba. Chybějící klíč, model mimo allowlist a
 * vyčerpaný strop jsou tři různé situace s třemi různými nápravami, a člověk,
 * který běh spouští, potřebuje vědět kterou. Každý důvod proto má vlastní kód
 * i vlastní větu s návodem.
 *
 * ## Allowlist modelů je jediné místo, kde smí identifikátor modelu vzniknout
 *
 * `plans/P8-odevzdani.md` T800 to žádá tvrdě, a `TOOLING.md` §2 to má jako
 * vedlejší efekt zploštěného IR (*„poskytovatel se stane vyměnitelným"*).
 * Model, který v `LIVE_MODELS` není, se nezavolá — a přidat ho je **vědomá
 * editace tohohle souboru**, ne překlep v proměnné prostředí. To je celý smysl
 * allowlistu: rozdíl mezi „zavolal jsem jiný model" a „rozhodl jsem se zavolat
 * jiný model".
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

export interface LiveModel {
  readonly id: string;
  readonly provider: 'openai';
  /** Úplná URL. Ne base + cesta složená jinde — složit se dá i něco jiného. */
  readonly url: string;
}

/**
 * Povolené modely živého běhu.
 *
 * **Rozhodnuto 14. 8. 2026: poskytovatel je OpenAI.** Ne volbou preference, ale
 * dostupností — uživatel jede na Max plánu, který dává Codex CLI, nikoli API
 * klíč, takže Anthropic API není z čeho volat. `TOOLING.md:35` tuhle cestu drží
 * otevřenou přímo: zploštěné IR bylo podmínkou Anthropic Structured Outputs,
 * ne jejich výsadou, a *„běží i na OpenAI"*.
 *
 * `EMISSION_MODEL` v `src/model/prompt.ts` zůstává `claude-opus-5`, protože
 * pojmenovává model **zmrazeného** korpusu a ten se přepsat nesmí (AC T2b).
 * Živý běh jméno přepíše až v požadavku, který skutečně odešle — a uloží ho
 * takhle přepsané, aby záznam nesl model, který doopravdy odpověděl.
 */
export const LIVE_MODELS: readonly LiveModel[] = [
  { id: 'gpt-5.6', provider: 'openai', url: 'https://api.openai.com/v1/chat/completions' },
  { id: 'gpt-5.6-mini', provider: 'openai', url: 'https://api.openai.com/v1/chat/completions' },
  { id: 'gpt-5.6-sol', provider: 'openai', url: 'https://api.openai.com/v1/chat/completions' },
];

// ---------------------------------------------------------------------------
// Výsledek
// ---------------------------------------------------------------------------

export type PreflightReason =
  /** `OPENAI_API_KEY` chybí nebo je prázdný. */
  | 'NO_CREDENTIALS'
  /** `EVAL_MODEL` není nastavený. */
  | 'NO_MODEL'
  /** `EVAL_MODEL` je nastavený, ale v `LIVE_MODELS` není. */
  | 'MODEL_NOT_ALLOWED'
  /** `EVAL_SPEND_CAP_USD` chybí. */
  | 'NO_SPEND_CAP'
  /** Strop není konečné kladné číslo. */
  | 'INVALID_SPEND_CAP'
  /** Chybí cena za milion tokenů — strop by se neměl z čeho počítat. */
  | 'NO_PRICE'
  /** Cena není konečné nezáporné číslo. */
  | 'INVALID_PRICE'
  /** Strop je vyčerpaný — už utraceno tolik co víc, než kolik bylo schváleno. */
  | 'CAP_EXHAUSTED';

export interface PreflightFailure {
  readonly ok: false;
  readonly reason: PreflightReason;
  /** Věta pro člověka, který běh spouští. **Nikdy nenese hodnotu klíče.** */
  readonly detail: string;
}

export interface LiveConfig {
  readonly ok: true;
  readonly model: LiveModel;
  readonly apiKey: string;
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly remainingUsd: number;
  readonly usdPerMillionInput: number;
  readonly usdPerMillionOutput: number;
}

export type PreflightResult = LiveConfig | PreflightFailure;

export type Env = Readonly<Record<string, string | undefined>>;

const fail = (reason: PreflightReason, detail: string): PreflightFailure => ({ ok: false, reason, detail });

/** Prázdný a jen-bílé-znaky řetězec je „nenastaveno", ne „nastaveno na nic". */
function required(env: Env, name: string): string | null {
  const raw = env[name];
  return raw === undefined || raw.trim().length === 0 ? null : raw.trim();
}

/**
 * Ověří credentials, model a zbývající strop — v tomhle pořadí.
 *
 * `spentUsd` je útrata, kterou běh nese s sebou. Volá se jednou před prvním
 * voláním (s nulou) a pak před každým dalším (s dosavadní útratou), takže
 * jediná funkce hlídá obojí: že se běh vůbec smí rozjet, a že se v půlce
 * zastaví.
 */
export function preflight(env: Env, spentUsd = 0): PreflightResult {
  const apiKey = required(env, 'OPENAI_API_KEY');
  if (apiKey === null)
    return fail(
      'NO_CREDENTIALS',
      'OPENAI_API_KEY není nastavený. Vlož ho ručně do .env.local — klíč z jiného projektu se sem nepřenáší.',
    );

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

  const capRaw = required(env, 'EVAL_SPEND_CAP_USD');
  if (capRaw === null)
    return fail('NO_SPEND_CAP', 'EVAL_SPEND_CAP_USD není nastavený. Bez schváleného stropu se živý běh nespouští.');

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
    model,
    apiKey,
    capUsd,
    spentUsd,
    remainingUsd,
    usdPerMillionInput: prices[0].value!,
    usdPerMillionOutput: prices[1].value!,
  };
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

/** Cena jednoho volání. Ceny jsou za milion tokenů — proto ten dělitel. */
export function costUsd(usage: Usage, config: LiveConfig): number {
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
  return [
    `model=${config.model.id}`,
    `provider=${config.model.provider}`,
    `cap=${config.capUsd.toFixed(2)}USD`,
    `spent=${config.spentUsd.toFixed(4)}USD`,
    `remaining=${config.remainingUsd.toFixed(4)}USD`,
    `price=${config.usdPerMillionInput}/${config.usdPerMillionOutput} per Mtok`,
  ].join(' ');
}

/**
 * Požadavek s **živým** jménem modelu.
 *
 * `buildEmissionRequest` plní `model` konstantou zmrazeného korpusu. Uložit
 * záznam s tím jménem by znamenalo tvrdit, že odpověděl model, který se
 * nezavolal — a přesně na tenhle druh záměny míří poznámka u T18 v plánu.
 */
export function withLiveModel(request: UpstreamRequest, config: LiveConfig): UpstreamRequest {
  return { ...request, model: config.model.id };
}
