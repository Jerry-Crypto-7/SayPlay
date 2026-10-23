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
import { AdmissionQueue } from '@/server/admission';
import { costUsd, processFallbackSpendCap, processSpendCap, type Reserved } from '@/server/spend-cap';
import { acquireSlot, DOOR_CEILING, releaseSlot } from '@/server/paid-slots';
import { upstreamBranch, type UpstreamConfig, upstreamConfigFromEnv } from '@/server/upstream';

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
 * kniha stropu je v paměti procesu a hra cenu nenese. `usd` je to, co strhl
 * strop – u volání bez účtenky celá rezervace.
 */
export function billedLine(model: string, usd: number): string {
  return `[play] director call billed model=${model} usd=${usd.toFixed(8)}`;
}

/**
 * Volání a vyrovnání jeho rezervace. Zrušené volání nemá účtenku a strhne celou
 * rezervaci (R1, rozhodnuto): poskytovatel mohl tokeny spálit až do zrušení
 * a odhad z uplynulého času by byl nižší číslo, tedy nebezpečná strana stropu.
 * U předplatného je cena 0 a mez drží počet volání, takže to nic nestojí.
 * Řádek účtenky nese, co strop doopravdy strhl (oříznutou cenu, bez účtenky celou
 * rezervaci), aby srovnání modelů neukázalo levnější model, který víc padá.
 */
async function billed(reservation: Reserved, config: UpstreamConfig, run: () => Promise<GenerationOutcome>): Promise<GenerationOutcome> {
  let outcome: GenerationOutcome | null = null;
  try {
    outcome = await run();
    return outcome;
  } finally {
    const charged = await reservation.settle(outcome === null || outcome.usage === null ? 'unknown' : costUsd(outcome.usage, config.pricing));
    console.info(billedLine(config.model, charged));
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
      // Vypínač znovu před každým voláním (P53, revize fáze 1): mezi čtením nahoře
      // a voláním stojí od P53 fronta na slot, až 240 s, a vypínač přepnutý
      // mezitím by jinak placené volání nezastavil – stejně jako u zálohy níž.
      if ((await killState(env)).upstream) return { ok: false, reason: 'UPSTREAM_REJECTED', detail: 'the upstream kill switch is on', usage: null };
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
 * Kolik režií smí čekat na slot dveří `play` (P53 T2). Šestnáct je dva nápory
 * poroty po osmi; čekající drží jen místo ve frontě, ne rezervaci stropu ani
 * volání. Nula = fronta vypnutá, třetí režie dostane návrh hned jako před P53.
 */
export const DEFAULT_PLAY_DIRECTOR_QUEUE = 16;

/** `PLAY_DIRECTOR_QUEUE`: celé číslo od 0; cokoli jiného řádek logu a výchozích 16. */
export function directorQueueLength(env: Record<string, string | undefined>): number {
  const raw = env.PLAY_DIRECTOR_QUEUE?.trim() ?? '';
  if (raw === '') return DEFAULT_PLAY_DIRECTOR_QUEUE;
  // `isSafeInteger`: třísetmístné číslo je `Infinity` a `AdmissionQueue` by se nepostavila vůbec.
  if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  console.warn(`[play] PLAY_DIRECTOR_QUEUE=${JSON.stringify(raw.slice(0, 40))} ignored: must be a whole number from 0; the queue keeps ${String(DEFAULT_PLAY_DIRECTOR_QUEUE)}`);
  return DEFAULT_PLAY_DIRECTOR_QUEUE;
}

/**
 * Fronta na sloty dveří `play`, jedna na proces. Na `globalThis` ze stejného
 * důvodu jako mapa prací v `_upgrade.ts`: routy PLAY jsou v Next.js oddělené
 * moduly a modulová proměnná by každá měla svou, tedy vlastní frontu i strop.
 * `createdAt`: čas přijetí starší než fronta by ona vzala jako rozbité hodiny.
 */
const QUEUE = Symbol.for('worldstream.play.director-queue');
type QueueHolder = { [QUEUE]?: { readonly queue: AdmissionQueue; readonly createdAt: number } };

/**
 * Termín čekání (P53 T2): fronta pustí volání, jen když po čekání zbývá
 * z rozpočtu trasy aspoň `minCallMs()` primáru – táž mez, kterou volání
 * kontroluje samo, takže fronta neodmítne nic, co by bez ní odešlo (gpt-oss
 * s 40 s zbytku). Pro astru je to `MIN_CALL_MS`, čekání tedy nejvýš 195 s.
 * Mez se čte z konfigurace při vzniku fronty; v provozu se za běhu nemění.
 */
function directorQueue(config: UpstreamConfig): { readonly queue: AdmissionQueue; readonly createdAt: number } {
  const holder = globalThis as QueueHolder;
  if (holder[QUEUE] === undefined) {
    const queue = new AdmissionQueue(
      { budgetMs: DIRECTOR_BUDGET_MS, minServiceMs: minCallMs(config), maxQueued: directorQueueLength(process.env) },
      {
        now: () => Date.now(),
        concurrency: DOOR_CEILING.play,
        onCoercedReceipt: ({ id }) => console.warn(`[play] director queue: ${id} came with an untrusted start time, its wait counts from now`),
      },
    );
    // `createdAt` až po frontě: čtené před ní je o milisekundu starší než její
    // vlastní vznik a první volání procesu by fronta hlásila jako rozbité hodiny
    // (naměřeno pod `next start` v P53 T4).
    holder[QUEUE] = { queue, createdAt: Date.now() };
  }
  return holder[QUEUE];
}

/** Stav fronty pro testy a log; bez fronty nuly. */
export function directorQueueState(): { readonly running: number; readonly queued: number } {
  const held = (globalThis as QueueHolder)[QUEUE];
  return held === undefined ? { running: 0, queued: 0 } : { running: held.queue.running, queued: held.queue.queued };
}

/**
 * Slot dveří `play` je volný hned (P53 T3a): nikdo nečeká a fronta nepouští plný
 * strop. Volitelné druhé volání bez něj čeká za cizími větami, i když fronta je prázdná.
 */
export function directorSlotFree(): boolean {
  const { running, queued } = directorQueueState();
  return queued === 0 && running < DOOR_CEILING.play;
}

/**
 * Pořadí práce `queueId` ve frontě na slot (P53 T3), 1 = další na řadě; `null`
 * = nečeká. Upgrade a remix si ho přidají ke stavu `pending`, který klient polluje.
 */
export function directorQueuePosition(queueId: string): number | null {
  return (globalThis as QueueHolder)[QUEUE]?.queue.position(queueId) ?? null;
}

/** Jen pro testy: zavře frontu (čekající dostanou `SHUTTING_DOWN`) a další volání postaví novou z prostředí. */
export function resetDirectorQueue(): void {
  const holder = globalThis as QueueHolder;
  holder[QUEUE]?.queue.close();
  delete holder[QUEUE];
}

let queueIds = 0;

/**
 * Slot dveří `play` přes frontu: počká, až je volno, a vrátí funkci, která ho
 * pustí dalšímu čekajícímu. Pod frontou se bere i slot `acquireSlot('play')`,
 * protože celkový strop placených volání sdílí s dveřmi studia – ten se při
 * plném dnu odmítne hned jako dřív. `refused` nese důvod pro řádek konce upgradu.
 * `queueId` dává volající, který chce pořadí ukázat (`directorQueuePosition`).
 */
function takePlaySlot(config: UpstreamConfig, startedAt: number, queueId?: string): Promise<{ readonly release: () => void } | { readonly refused: string }> {
  const { queue, createdAt } = directorQueue(config);
  queueIds += 1;
  const id = queueId ?? `play-${String(queueIds)}`;
  return new Promise((resolve) => {
    const work = () =>
      new Promise<void>((leave) => {
        if (!acquireSlot('play')) {
          leave();
          resolve({ refused: 'no free play slot' });
          return;
        }
        resolve({
          release: () => {
            releaseSlot('play');
            leave();
          },
        });
      });
    void queue.submit(id, work, Math.max(startedAt, createdAt)).then(({ verdict }) => {
      if (!verdict.admitted) resolve({ refused: `no free play slot: ${verdict.reason}` });
    });
  });
}

const refusedBy = (detail: string): GenerationOutcome => ({ ok: false, reason: 'UPSTREAM_REJECTED', detail, usage: null });

/**
 * Jedno placené volání s vlastním požadavkem (P27C T4, remix vlastní větou):
 * tytéž brány jako `getDirector` – objednávka, vypínač `upstream`, strop
 * utrácení, počet volajícího, rozpočet trasy a slot dveří `play` (od P53 přes
 * frontu). Bez kterékoli z nich se nevolá a výsledek je `UPSTREAM_REJECTED`.
 */
export async function callDirectorModel(startedAt: number, caller: string, request: UpstreamRequest, prompt: string, queueId?: string): Promise<GenerationOutcome> {
  const calls = directorCalls(startedAt, caller, queueId);
  try {
    return await calls.call(request, prompt);
  } finally {
    calls.close();
  }
}

/**
 * Placená volání jedné práce na jednom slotu (P53 T3a): slot se vezme u prvního
 * volání a drží do `close()`, takže druhé volání téže práce (opravné kolo
 * remixu) nečeká na konci fronty za cizími větami. Každé volání projde týmiž
 * branami jako `callDirectorModel`; `close()` patří do `finally`.
 */
export function directorCalls(startedAt: number, caller: string, queueId?: string): { readonly call: (request: UpstreamRequest, prompt: string) => Promise<GenerationOutcome>; readonly close: () => void } {
  let seat: { readonly release: () => void } | null = null;
  return {
    call: async (request, prompt) => {
      const config = upstreamConfigFromEnv(process.env);
      const branch = await cappedBranch(process.env, startedAt + DIRECTOR_BUDGET_MS, caller, () => {});
      if (branch === null || config === null) return refusedBy('the paid director branch is not available');
      if (seat === null) {
        const taken = await takePlaySlot(config, startedAt, queueId);
        if ('refused' in taken) return refusedBy(taken.refused);
        seat = taken;
      }
      return branch.generate({ prompt, request });
    },
    close: () => {
      seat?.release();
      seat = null;
    },
  };
}

/**
 * Placená větev drží jeden slot **vlastních dveří `play`** od prvního volání
 * modelu do konce režie – pod týmž celkovým stropem souběžných placených volání
 * jako `/api/generate` a relace WORLDSTREAM, ale s vlastním čítačem, aby visící
 * režie nezavřela `/api/generate` (druhé kolo revize T1). Bez slotu se model
 * nevolá a hra je návrh: jinak by jeden volající se stovkou různých vět
 * vyčerpal strop volání celého dema (nález revize T1).
 *
 * **Od P53 T2 se na slot čeká ve frontě**, a až u prvního volání modelu, ne před
 * režií: věta z cache model nevolá, takže za dvěma pomalými větami nečeká.
 * Opravné kolo jede na slotu, který režie už drží.
 *
 * `startedAt` je příchod požadavku (`Date.now()`), jehož `maxDuration` režii drží.
 */
export function getDirector(startedAt: number, caller: string, check?: DirectorDeps['check'], nudge?: string, queueId?: string, waitForSlot = true): Director {
  return async (sentence) => {
    const deadline = startedAt + DIRECTOR_BUDGET_MS;
    const cache = directorCacheFromEnv(process.env);
    let callerLimited = false;
    const config = upstreamConfigFromEnv(process.env);
    const branch = await cappedBranch(process.env, deadline, caller, () => {
      callerLimited = true;
    });
    if (branch === null || config === null) return { ...(await direct(sentence, { branch: NO_MODEL, cache, now: Date.now })), callerLimited };
    let seat: { readonly release: () => void } | null = null;
    const queued: GenerationBranch = {
      ...branch,
      async generate(call) {
        if (seat === null) {
          // `waitForSlot: false` (P53 T3b): odpověď, na kterou hráč kouká, nečeká mlčky ve frontě –
          // bez volného slotu se model nevolá jako před P53; věta z cache sem nedojde, ta projde.
          if (!waitForSlot && !directorSlotFree()) return refusedBy('no free play slot: this path does not wait in line');
          const taken = await takePlaySlot(config, startedAt, queueId);
          if ('refused' in taken) return refusedBy(taken.refused);
          seat = taken;
        }
        return branch.generate(call);
      },
    };
    try {
      // P27D T2: kompaktní první odpověď je výchozí – živě 30/30 hratelných, p50 12 s proti 45 s
      // a věrnost `drawn` 0,727 proti 0,702 (`evals/play/fidelity/README.md`). Celý GameSpec jen na objednávku.
      const compact = process.env.PLAY_DIRECTOR_MODE !== 'full';
      // P30A T8: ověřené příklady jen na objednávku, dokud T10 nezměří, jestli pomáhají.
      const examples = process.env.PLAY_DIRECTOR_EXAMPLES === 'on';
      return { ...(await direct(sentence, { branch: queued, cache, now: Date.now, check, compact, examples, caller, ...(nudge === undefined ? {} : { nudge }) })), callerLimited };
    } finally {
      // `seat` přiřazuje `generate` výš; TypeScript to po `await` nevidí.
      (seat as { readonly release: () => void } | null)?.release();
    }
  };
}
