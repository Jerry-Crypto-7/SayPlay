/**
 * Šev režiséra pro obálku (P23-D T1): `direct()` z `src/play/director`.
 *
 * Bez objednané a nakonfigurované živé větve se model nevolá vůbec a hra je
 * návrh ze slov (`source: 'draft'`, `fallbackReason: 'MODEL_UNAVAILABLE'`).
 * S ní jde každé volání přes **týž procesní strop utrácení** jako WORLDSTREAM
 * (`processSpendCap()` na `globalThis`): rezervace nejhoršího případu před
 * voláním, vyrovnání po něm. Odmítnutý strop je pro režiséra výpadek modelu,
 * takže hráč dostane návrh, ne chybu. Placená záloha (P30A T3) platí z vlastního
 * stropu `processFallbackSpendCap()`.
 *
 * Produkce (P30A): primár gpt-oss-20b přes sdílené API (`openai:`), záloha astra
 * přes placené API. `codex-cli` (předplatné) zůstává jen pro vývoj.
 *
 * Objednávka se čte jako v `/api/generate` (`WORLDSMITH_BRANCH === 'live'`)
 * a vypínač `upstream` ji ruší – klíč zděděný z jiného projektu tak placenou
 * cestu nezapne.
 *
 * Podtržítko v názvu: Next.js soubor nebere jako route.
 */

import { direct, directorCacheFromEnv, type DirectedGame, type DirectorDeps } from '@/play/director';
import { VersionStoreUnavailable, versionStoreFromEnv } from '@/play/version';
import { killState } from '@/server/kill-switch';
import type { UpstreamRequest } from '@/model/prompt';
import type { GenerationBranch, GenerationOutcome } from '@/server/pipeline';
import { costUsd, processFallbackSpendCap, processSpendCap, type Reserved } from '@/server/spend-cap';
import { upstreamBranch, type UpstreamConfig, upstreamConfigFromEnv } from '@/server/upstream';

import { acquireSlot, releaseSlot } from '../worldstream/sessions/route';

/**
 * `callerLimited`: model se nezavolal, protože volající vyčerpal svůj denní
 * počet. Takový návrh neříká nic o větě – upgrade ho proto nepamatuje (revize R8).
 */
export type Director = (sentence: string) => Promise<DirectedGame & { readonly callerLimited: boolean }>;

/**
 * Kolik smí trvat celá režie (R7). Routy PLAY mají `maxDuration = 300` s;
 * když platforma funkci zabije uprostřed volání, `settle()` neproběhne
 * a rezervace stropu visí do expirace knihy. Rozpočet běží od příchodu
 * požadavku, ne od začátku režie, a timeout každého volání se zkrátí na čas,
 * který z něj zbývá – nasazený timeout (285 s kvůli codex-shimu) je delší než
 * celý rozpočet, takže odmítnutí místo zkrácení by nepustilo volání nikdy
 * (revize R7). Zbylých 30 s patří kompilaci a zápisu. Kompilace čtyř semínek
 * je naměřeně pod 2 s (P23-D T3: medián 25 ms, max 445 ms na semínko), vlastní
 * strop souběhu nepotřebuje.
 *
 * Rozpočet drží platforma (`maxDuration`), ne poskytovatel, takže je jeden pro
 * všechny (P30A T3); podle poskytovatele se liší jen `minCallMs()` a timeout
 * volání, který se na zbytek rozpočtu zkracuje.
 */
export const DIRECTOR_BUDGET_MS = 270_000;

/**
 * Pod tohle volání neodejde. Plánovač astry trvá naměřeně ~75 s (P21), takže
 * kratší zbytek by zaplatil volání, které skoro jistě nedoběhne, a zahodil i
 * placenou první odpověď (revize R7, kolo 2).
 */
export const MIN_CALL_MS = 75_000;

/**
 * Totéž pro gpt-oss (P30A T3). Kompaktní odpověď na lokální RTX 3090 trvala
 * naměřeně p50 4,5 s, p90 11 s a nejvýš 26,4 s (`evals/play/local-director.json`,
 * 26. 9. 2026); 30 s je nad tím maximem. Hostovaný poskytovatel má být rychlejší,
 * jestli je, změří T9/T10.
 */
export const OSS_MIN_CALL_MS = 30_000;

/**
 * Kolik rozpočtu musí zbývat, aby volání odešlo. Rozhoduje model, ne transport:
 * astra přes placené API je stejně pomalá jako přes předplatné. Záloha zdarma
 * (llama.cpp) mez nemá – nedoběhlé volání nic nestojí.
 */
export function minCallMs(config: UpstreamConfig): number {
  if (config.pricing.usdPerMTokOut === 0) return 0;
  return /gpt-oss-20b/i.test(config.model) ? OSS_MIN_CALL_MS : MIN_CALL_MS;
}

/**
 * Kolik placených volání režiséra smí jeden volající za den (R8). Věta stojí
 * 1–3 volání, takže výchozích 12 je 4–12 vět; bez meze by jeden volající
 * různými větami vyčerpal sdílený strop celého dema. Pod výchozím stropem
 * 5 USD vyjde ~19 volání v nejhorším případě, takže 12 nechá zbytek ostatním
 * (revize R8).
 */
export const DEFAULT_DIRECTOR_CALLS_PER_CALLER = 12;

/**
 * Po kolika ms bez odpovědi primáru se pustí lokální záloha (P29B T8).
 * Předplatné umí viset 285–317 s (`evals/play/fidelity/README.md`) a kompaktní
 * odpověď má p50 12 s; 30 s nechá primáru dvojnásobek mediánu s rezervou.
 * Jestli je mez správná, rozhodne živé měření za HALT – proto proměnná.
 */
export const DEFAULT_HEDGE_MS = 30_000;

function hedgeMs(env: Record<string, string | undefined>): number {
  const value = Number(env.PLAY_DIRECTOR_HEDGE_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_HEDGE_MS;
}

/**
 * Kolik placených záloh smí na instanci běžet naráz (T2b, revize hranice fáze 1).
 *
 * Záloha má vlastní zásobu, ne slot dveří `play`: dveře mají dva sloty a dvě
 * režie je obsadí, takže záloha braná ze stejné zásoby by se při výpadku
 * primáru odmítla u obou a obě hry by byly návrhy ze slov, ačkoli strop zálohy
 * je netknutý. Dvě = jedna na každý dnešní slot dveří; širší dveře zálohu
 * nerozšíří. Celkový strop souběžných placených volání ji nepočítá – drží počet
 * vět v letu a záloha je druhé volání věty, která v něm už je; peníze zálohy
 * drží její vlastní strop.
 */
export const MAX_PAID_FALLBACKS = 2;
let paidFallbacks = 0;

type Call = (signal: AbortSignal) => Promise<GenerationOutcome>;

/**
 * Souběh primáru se zálohou: záloha startuje po `hedgeAfterMs`, nebo hned,
 * když primár selže dřív. První úspěšná odpověď vyhraje a druhé volání se
 * zruší. Když selžou obě, vrací se selhání primáru – o větě říká víc.
 * Vyhozená výjimka je selhání, ne pád režie.
 */
export function hedged(primary: Call, fallback: Call | null, hedgeAfterMs: number): Promise<GenerationOutcome> {
  const primaryCtl = new AbortController();
  const settle = (call: Call, ctl: AbortController): Promise<GenerationOutcome> =>
    call(ctl.signal).catch((thrown: unknown) => ({ ok: false, reason: 'UPSTREAM_UNAVAILABLE', detail: (thrown as Error).message, usage: null }));
  if (fallback === null) return settle(primary, primaryCtl);

  const fallbackCtl = new AbortController();
  return new Promise((resolve) => {
    let done = false;
    let fallbackStarted = false;
    let primaryFailure: GenerationOutcome | null = null;
    let fallbackFailed = false;
    let fallbackRun: Promise<GenerationOutcome> | null = null;
    // Vrací se až po doběhnutí zrušeného volání (R1): rezervace primáru se tak
    // vyrovná dřív, než trasa pustí slot. Zabíjený codex tím přidá nejvýš
    // `CODEX_KILL_GRACE_MS` k odpovědi, která už stejně čekala přes mez.
    const finish = (outcome: GenerationOutcome, loser: AbortController | null, loserRun: Promise<GenerationOutcome> | null) => {
      done = true;
      clearTimeout(timer);
      loser?.abort();
      void (loserRun ?? Promise.resolve()).then(() => resolve(outcome));
    };
    const startFallback = () => {
      if (fallbackStarted || done) return;
      fallbackStarted = true;
      clearTimeout(timer);
      fallbackRun = settle(fallback, fallbackCtl);
      void fallbackRun.then((outcome) => {
        if (done) return;
        if (outcome.ok) finish(outcome, primaryCtl, primaryRun);
        else if (primaryFailure !== null) finish(primaryFailure, null, null);
        else fallbackFailed = true;
      });
    };
    const timer = setTimeout(startFallback, hedgeAfterMs);
    const primaryRun = settle(primary, primaryCtl);
    void primaryRun.then((outcome) => {
      if (done) return;
      if (outcome.ok) return finish(outcome, fallbackStarted ? fallbackCtl : null, fallbackRun);
      primaryFailure = outcome;
      if (fallbackFailed) finish(outcome, null, null);
      else startFallback();
    });
  });
}

function callsPerCaller(env: Record<string, string | undefined>): number {
  const value = Number(env.PLAY_DIRECTOR_CALLS_PER_CALLER);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_DIRECTOR_CALLS_PER_CALLER;
}

/** Počítadlo volajícího; nedostupné úložiště volání nepustí. */
async function callerAllows(caller: string, env: Record<string, string | undefined>): Promise<boolean> {
  try {
    return await versionStoreFromEnv(env).takeDirectorCall(caller, callsPerCaller(env));
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return false;
    throw thrown;
  }
}

/**
 * Řádek logu s cenou jednoho volání (P30A T7). Srovnání modelů
 * (`scripts/play-fidelity.mjs --models`) ho sčítá ze serveru, který spustí:
 * kniha stropu je v paměti procesu a hra cenu nenese. `unknown` = volání bez
 * účtenky, strop za něj strhl celou rezervaci.
 */
export function billedLine(model: string, usd: number | 'unknown'): string {
  return `[play] director call billed model=${model} usd=${usd === 'unknown' ? 'unknown' : usd.toFixed(8)}`;
}

/**
 * Volání a vyrovnání jeho rezervace. Zrušené volání nemá účtenku a strhne celou
 * rezervaci (R1, rozhodnuto): poskytovatel mohl tokeny spálit až do zrušení
 * a odhad z uplynulého času by byl nižší číslo, tedy nebezpečná strana stropu.
 * U předplatného je cena 0 a mez drží počet volání, takže to nic nestojí.
 */
async function billed(reservation: Reserved, config: UpstreamConfig, run: () => Promise<GenerationOutcome>): Promise<GenerationOutcome> {
  try {
    const outcome = await run();
    const usd = outcome.usage === null ? 'unknown' : costUsd(outcome.usage, config.pricing);
    await reservation.settle(usd);
    console.info(billedLine(config.model, usd));
    return outcome;
  } catch (thrown) {
    await reservation.settle('unknown');
    console.info(billedLine(config.model, 'unknown'));
    throw thrown;
  }
}

/** Živá větev obalená stropem; `null` = model se volat nebude. */
async function cappedBranch(
  env: Record<string, string | undefined>,
  deadline: number,
  caller: string,
  onCallerLimit: () => void,
): Promise<GenerationBranch | null> {
  if (env.WORLDSMITH_BRANCH !== 'live') return null;
  if ((await killState(env)).upstream) return null;
  const config = upstreamConfigFromEnv(env);
  if (config === null) return null;
  const branch = upstreamBranch(config);
  const cap = processSpendCap();
  return {
    id: branch.id,
    pricing: branch.pricing,
    worstCaseUsd: (call) => branch.worstCaseUsd(call),
    async generate(call) {
      const left = deadline - Date.now();
      if (left < minCallMs(config)) {
        console.warn(`[play] director call skipped: ${String(Math.round(left / 1000))} s left of the route budget`);
        return { ok: false, reason: 'UPSTREAM_REJECTED', detail: 'too little time left in the route', usage: null };
      }
      const bounded = left < config.timeoutMs ? upstreamBranch({ ...config, timeoutMs: left }) : branch;
      const reservation = await cap.reserve(branch.worstCaseUsd(call));
      if (!reservation.ok) return { ok: false, reason: 'UPSTREAM_REJECTED', detail: 'spend cap refused the call', usage: null };
      // Počet volajícího až po rezervaci: odmítnutí stropem mu volání neubere (revize R8).
      if (!(await callerAllows(caller, env))) {
        await reservation.settle(0);
        onCallerLimit();
        return { ok: false, reason: 'UPSTREAM_REJECTED', detail: "the caller's daily director calls are used up", usage: null };
      }
      const primary: Call = (signal) => billed(reservation, config, () => bounded.generate(call, signal));
      // Záloha mimo kvótu volajícího, jen v mezích rozpočtu trasy. Placená
      // (`openai:`, P30A T3) platí z vlastního stropu `processFallbackSpendCap()`,
      // takže vyčerpaná záloha nechá hru na primáru a hlavní strop jí nic neubere;
      // lokální llama.cpp má nejhorší případ 0 a projde i nulovým stropem.
      const backup = config.fallback;
      const fallback: Call | null =
        backup === undefined
          ? null
          : async (signal) => {
              const rest = deadline - Date.now();
              if (rest < minCallMs(backup)) return { ok: false, reason: 'UPSTREAM_REJECTED', detail: 'too little time left for the fallback', usage: null };
              // Vypínač znovu až tady (revize T3): záloha startuje až po `hedgeMs`
              // a vypínač přepnutý mezitím by jinak placené volání nezastavil.
              if ((await killState(env)).upstream) return { ok: false, reason: 'UPSTREAM_REJECTED', detail: 'the upstream kill switch is on', usage: null };
              const side = upstreamBranch({ ...backup, timeoutMs: Math.max(1, Math.min(backup.timeoutMs, rest)) });
              const worstCaseUsd = side.worstCaseUsd(call);
              // Placená záloha je druhé placené volání v letu, takže bere slot
              // z vlastní zásoby `MAX_PAID_FALLBACKS` (T2a, T2b), ne ze slotů dveří
              // `play`. Bez volného slotu se nespustí a hra jede jen na primáru.
              // Záloha zdarma (llama.cpp) slot nebere. Kvótu volajícího nebere ani
              // placená: ta je mez vět na volajícího a věta je pořád jedna.
              const paid = worstCaseUsd > 0;
              if (paid && paidFallbacks >= MAX_PAID_FALLBACKS) return { ok: false, reason: 'UPSTREAM_REJECTED', detail: 'no free slot for the paid fallback', usage: null };
              if (paid) paidFallbacks += 1;
              try {
                const held = await processFallbackSpendCap().reserve(worstCaseUsd);
                if (!held.ok) return { ok: false, reason: 'UPSTREAM_REJECTED', detail: 'the fallback spend cap refused the call', usage: null };
                const outcome = await billed(held, backup, () => side.generate(call, signal));
                // Role, ne transport: hru od zálohy režie nedá do cache pod klíč primáru.
                return outcome.ok ? { ...outcome, provenance: { ...outcome.provenance, fallback: true } } : outcome;
              } finally {
                if (paid) paidFallbacks -= 1;
              }
            };
      return hedged(primary, fallback, hedgeMs(env));
    },
  };
}

/**
 * Větev bez modelu: `direct()` z ní udělá návrh ze slov, nikam se nevolá.
 * Má totéž `id` (`'live'`) jako živá, takže bez slotu se cache čte pod týmž
 * klíčem a táž věta dá tutéž hru bez ohledu na zátěž (R8).
 */
const NO_MODEL: GenerationBranch = upstreamBranch(null);

/**
 * Jedno placené volání s vlastním požadavkem (P27C T4, remix vlastní větou):
 * tytéž brány jako `getDirector` – objednávka, vypínač `upstream`, strop
 * utrácení, počet volajícího, rozpočet trasy a slot dveří `play`. Bez
 * kterékoli z nich se nevolá a výsledek je `UPSTREAM_REJECTED`.
 */
export async function callDirectorModel(startedAt: number, caller: string, request: UpstreamRequest, prompt: string): Promise<GenerationOutcome> {
  const branch = await cappedBranch(process.env, startedAt + DIRECTOR_BUDGET_MS, caller, () => {});
  if (branch === null) return { ok: false, reason: 'UPSTREAM_REJECTED', detail: 'the paid director branch is not available', usage: null };
  if (!acquireSlot('play')) return { ok: false, reason: 'UPSTREAM_REJECTED', detail: 'no free play slot', usage: null };
  try {
    return await branch.generate({ prompt, request });
  } finally {
    releaseSlot('play');
  }
}

/**
 * Placená větev drží po celou režii jeden slot **vlastních dveří `play`** – pod
 * týmž celkovým stropem souběžných placených volání jako `/api/generate` a
 * relace WORLDSTREAM, ale s vlastním čítačem, aby visící režie nezavřela
 * `/api/generate` (druhé kolo revize T1). Bez volného slotu se model nevolá a
 * hra je návrh: jinak by jeden volající se stovkou různých vět vyčerpal strop
 * volání celého dema (nález revize T1).
 *
 * `startedAt` je příchod požadavku (`Date.now()`), jehož `maxDuration` režii drží.
 */
export function getDirector(startedAt: number, caller: string, check?: DirectorDeps['check']): Director {
  return async (sentence) => {
    const deadline = startedAt + DIRECTOR_BUDGET_MS;
    const cache = directorCacheFromEnv(process.env);
    let callerLimited = false;
    const branch = await cappedBranch(process.env, deadline, caller, () => {
      callerLimited = true;
    });
    if (branch === null || !acquireSlot('play')) return { ...(await direct(sentence, { branch: NO_MODEL, cache, now: Date.now })), callerLimited };
    try {
      // P27D T2: kompaktní první odpověď je výchozí – živě 30/30 hratelných, p50 12 s proti 45 s
      // a věrnost `drawn` 0,727 proti 0,702 (`evals/play/fidelity/README.md`). Celý GameSpec jen na objednávku.
      const compact = process.env.PLAY_DIRECTOR_MODE !== 'full';
      // P30A T8: ověřené příklady jen na objednávku, dokud T10 nezměří, jestli pomáhají.
      const examples = process.env.PLAY_DIRECTOR_EXAMPLES === 'on';
      return { ...(await direct(sentence, { branch, cache, now: Date.now, check, compact, examples })), callerLimited };
    } finally {
      releaseSlot('play');
    }
  };
}
