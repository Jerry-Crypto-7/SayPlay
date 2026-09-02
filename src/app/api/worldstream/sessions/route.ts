/**
 * `POST /api/worldstream/sessions` — z věty vznikne relace (P13 T16, §21).
 *
 * Odpověď je **202 a adresa proudu**, ne hotový svět. Design book to říká
 * doslova: „validní odpověď neznamená hotový svět". Generace běží dál za
 * odpovědí a hlásí se rámci do relace (`src/worldstream/sessions.ts`).
 *
 * ## Čtyři brány, v tomhle pořadí
 *
 * 1. **Tvar těla.** Přijímá se **prompt a nic jiného**. Klíč navíc je 400, ne
 *    tiše ignorovaný — kdyby se ignoroval, `shapes` nebo `geometry` od klienta
 *    by vypadaly jako přijaté a produkt by tvrdil, že geometrii píše model,
 *    zatímco by ji směl podstrčit kdokoli.
 * 2. **Moderace** (`src/server/moderation.ts`), tedy táž brána jako `/api/emit`.
 * 3. **Admission**: požadavek, kterému už vypršel rozpočet, se nepouští
 *    k modelu, a souběžných generací běží nejvýš `MAX_CONCURRENT_GENERATIONS`.
 * 4. **Strop utrácení** — uvnitř emitoru, u každého placeného volání zvlášť.
 *
 * ## Proč tu není `AdmissionQueue`, ačkoli je napsaná
 *
 * `submit()` splní slib **až když práce doběhne**, a tahle route musí odpovědět
 * dřív, než práce doběhne — jinak se 202 změní v „počkej si třicet vteřin".
 * Fronta se sem tedy nedá zapojit tak, jak je: zapojení celé ochrany proti
 * náporu je vlna 7 (T28) a bude potřebovat slot držený **napříč** požadavkem
 * a generací. Do té doby drží nápor dvě věci, které tuhle vlastnost nemají:
 * `admit()` na promlčeném rozpočtu a čítač souběžných generací níž.
 */

import { randomUUID } from 'node:crypto';

import { readBody } from '../../../../http/body';
import { withRequest } from '../../../../obs/trace';
import type { UpstreamRequest } from '../../../../model/prompt';
import { admit, type AdmissionPolicy } from '../../../../server/admission';
import { moderatePrompt } from '../../../../server/moderation';
import { logRateLimited } from '../../../../server/public-faults';
import { costUsd, spendCapFromEnv } from '../../../../server/spend-cap';
import { upstreamBranch, upstreamConfigFromEnv } from '../../../../server/upstream';
import type { BlueprintEmitter } from '../../../../model/worldstream-repair';
import {
  newSessionSeed,
  openSession,
  runGeneration,
  serverGrammar,
  type SessionFault,
} from '../../../../worldstream/sessions';

/** Zmrazený protokol se čte ze souboru a `AsyncLocalStorage` chce Node. */
export const runtime = 'nodejs';

/**
 * Kolik generací smí běžet naráz.
 *
 * Není to výkonnostní ladění, je to strop na **placená volání v letu**: každá
 * generace stojí dvě až čtyři volání modelu a strop utrácení je kontrola po
 * volání, ne před náporem. Čtyři je nad tím, co porotce vyrobí sám, a pod tím,
 * co by z jednoho návštěvníka udělalo účet za den.
 */
export const MAX_CONCURRENT_GENERATIONS = 4;

/**
 * Rozpočet jednoho požadavku od chvíle, kdy dorazil.
 *
 * `minServiceMs` je 3 000 schválně: cíl §22.1 je p95 do hrubého světa pod 3 s,
 * takže požadavek, kterému zbývá míň, se nemá čeho chytit a je poctivější ho
 * odmítnout hned než ho pustit k modelu a zaplatit za odpověď, která přijde
 * pozdě.
 */
export const SESSION_POLICY: AdmissionPolicy = {
  budgetMs: 15_000,
  minServiceMs: 3_000,
  maxQueued: 0,
};

let running = 0;

/** Jen pro testy: čítač je proces-globální jako registr relací. */
export function resetConcurrency(): void {
  running = 0;
}

function fail(requestId: string, status: number, code: string, message: string): Response {
  return Response.json({ requestId, error: { code, message } }, { status });
}

/**
 * Emitor, který mluví s poskytovatelem a **platí za to**.
 *
 * Vypadá jako `liveEmitter()` z měřidla T14 a je to jiná věc: ten archivuje
 * a scrubuje, protože jeho výstup jde do commitnutého souboru. Tenhle nesmí
 * ven pustit **nic** — text výjimky nese adresu koncového bodu a `fetch` ji
 * píše do hlášek celou, takže ho čte jen `runGeneration`, který ho přeloží na
 * veřejnou větu a detail pošle do logu operátora.
 *
 * `null` znamená „cloudová větev není nakonfigurovaná". Relace se i tak
 * založí a skončí `session.failed`: 503 rovnou by porotci vzalo proud, ve
 * kterém je ta příčina vidět, a `RULES.md` §3.3 mu dává právo zkoušet vlastní
 * věty i tehdy, když je nasazení bez klíče.
 */
export function cloudEmitter(env: NodeJS.ProcessEnv = process.env): BlueprintEmitter | null {
  const config = upstreamConfigFromEnv(env);
  if (config === null) return null;

  const branch = upstreamBranch(config);
  const cap = spendCapFromEnv(env);

  return async (request: UpstreamRequest): Promise<unknown> => {
    const call = { prompt: request.user, request };
    const reservation = cap.reserve(branch.worstCaseUsd(call));
    if (!reservation.ok) throw new Error(`${reservation.reason}: ${reservation.detail}`);

    let outcome;
    try {
      outcome = await branch.generate(call);
    } catch (thrown) {
      // Rezervaci vyrovnat **před** rethrow, jinak visí do restartu procesu a
      // strop se sám utáhne — táž oprava jako v `runPipeline`.
      reservation.settle('unknown');
      throw thrown;
    }

    reservation.settle(outcome.usage === null ? 'unknown' : costUsd(outcome.usage, branch.pricing));
    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.detail}`);
    return outcome.body;
  };
}

interface PromptRead {
  readonly ok: true;
  readonly prompt: unknown;
}

/** Tělo je `{ prompt }` a nic víc. Klíč navíc je vada, ne přebytek. */
function readPrompt(text: string): PromptRead | { readonly ok: false; readonly code: string; readonly message: string } {
  let body: unknown;
  try {
    body = JSON.parse(text === '' ? 'null' : text);
  } catch {
    return { ok: false, code: 'BODY_NOT_JSON', message: 'the request body is not JSON' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, code: 'BODY_NOT_AN_OBJECT', message: 'the request body is not a JSON object' };

  const extra = Object.keys(body).filter((key) => key !== 'prompt');
  if (extra.length > 0)
    return {
      ok: false,
      code: 'UNEXPECTED_FIELDS',
      message: `this endpoint takes a prompt and nothing else; it will not accept ${extra.join(', ')}`,
    };

  return { ok: true, prompt: (body as { prompt?: unknown }).prompt };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const receivedAtMs = Date.now();

  return withRequest(requestId, async () => {
    let raw;
    try {
      raw = await readBody(request);
    } catch (thrown) {
      logRateLimited(
        'worldstream/sessions',
        requestId,
        'BODY_UNREADABLE',
        thrown instanceof Error ? thrown.message : String(thrown),
      );
      return fail(requestId, 400, 'BODY_UNREADABLE', 'the request body could not be read');
    }
    if (!raw.ok)
      return fail(
        requestId,
        raw.reason === 'TOO_LARGE' ? 413 : 408,
        raw.reason,
        raw.reason === 'TOO_LARGE' ? 'the request body is too large' : 'the request body arrived too slowly',
      );

    const read = readPrompt(raw.text);
    if (!read.ok) return fail(requestId, 400, read.code, read.message);

    const verdict = moderatePrompt(read.prompt);
    if (!verdict.ok) return fail(requestId, 400, verdict.category, verdict.detail);

    const admission = admit(requestId, receivedAtMs, Date.now(), SESSION_POLICY);
    if (!admission.admitted)
      return fail(requestId, 503, admission.reason, 'the request ran out of its time budget before any work began');

    if (running >= MAX_CONCURRENT_GENERATIONS)
      return fail(requestId, 503, 'TOO_MANY_SESSIONS', 'too many worlds are being built right now');

    const grammar = serverGrammar();
    if (typeof grammar === 'string') {
      logRateLimited('worldstream/sessions', requestId, 'GRAMMAR_UNREADABLE', grammar);
      return fail(requestId, 503, 'GRAMMAR_UNREADABLE', 'the frozen protocol could not be read');
    }

    const sessionId = randomUUID();
    const stored = openSession(sessionId, newSessionSeed());

    const emit = cloudEmitter();
    running += 1;
    const work =
      emit === null
        ? Promise.resolve().then(() => {
            stored.fault = 'the model could not be reached';
            stored.session.fail(stored.fault);
          })
        : runGeneration(stored, verdict.prompt, {
            emit,
            grammar,
            log: (fault: SessionFault, detail: string) =>
              logRateLimited('worldstream/sessions', requestId, fault, detail),
          });

    // **`void` s `finally`, ne `await`.** Odpověď 202 musí odejít dřív, než
    // generace doběhne — to je celý smysl téhle route. `finally` je jediné,
    // co drží čítač souběhu poctivý i na cestě, kterou nikdo nečeká.
    void work.finally(() => {
      running -= 1;
    });

    return Response.json(
      {
        requestId,
        sessionId,
        events: `/api/worldstream/sessions/${sessionId}/events`,
        snapshot: `/api/worldstream/sessions/${sessionId}`,
      },
      { status: 202 },
    );
  });
}
