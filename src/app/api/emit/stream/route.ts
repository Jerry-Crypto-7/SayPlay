/**
 * `POST /api/emit/stream` — tentýž verdikt jako `/api/emit`, ale s průběhem.
 *
 * Emise projde šesti kroky a ten poslední (replay svědka) je z nich zdaleka
 * nejdražší. Bez kanálu s průběhem stojí viewer nad prázdným plátnem a jediné,
 * co může ukázat, je točící se kolečko — což je přesně ta obrazovka, kterou si
 * `DESIGN-BOOK.md` §13.4 zakazuje.
 *
 * **Verdikt je tentýž objekt**, jaký vrací `POST /api/emit`, jen jede jako
 * poslední rámec. Řetěz je jeden (`../chain.ts`), takže se ty dvě cesty nemají
 * jak rozejít.
 *
 * ## Proč se streamuje POSTem a ne přes `EventSource`
 *
 * `EventSource` umí jen GET, a emise se vyvolává tělem s `promptId`. Klientská
 * polovina je proto `fetch` a ruční dekodér v `src/components/viewer/sse.ts`.
 *
 * ## Mezi kroky se pouští smyčka událostí, a je to nosná část
 *
 * Řetěz je čistě synchronní. Kdyby se protočil vcelku, všechny rámce by se
 * zařadily do fronty proudu dřív, než by kterýkoli opustil socket — průběh by
 * dorazil naráz s verdiktem a kanál by byl jen na oko. `emissionSteps` je proto
 * generátor a tahle smyčka mezi jeho kroky uvolní smyčku událostí, takže rámec
 * skutečně odejde dřív, než začne replay.
 */

import { randomUUID } from 'node:crypto';

import { withRequest } from '../../../../obs/trace';
import { emissionSteps, type EmitPhase } from '../chain';
import { readPromptId } from '../route';

export const runtime = 'nodejs';

function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Uvolní smyčku událostí, aby zařazený rámec stihl odejít. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();

  return withRequest(requestId, async () => {
    const parsed = await readPromptId(request, requestId);
    if (!parsed.ok) return parsed.response;

    const promptId = parsed.promptId;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let step = 0;
        const send = (phase: EmitPhase | 'requested') => {
          step += 1;
          controller.enqueue(encoder.encode(frame('progress', { phase, step })));
        };

        send('requested');
        await flush();

        const steps = emissionSteps(promptId);
        let next = steps.next();
        while (!next.done) {
          send(next.value);
          await flush();
          next = steps.next();
        }
        const outcome = next.value;

        if (outcome.kind === 'unavailable')
          controller.enqueue(
            encoder.encode(
              frame('result', { requestId, error: { code: outcome.failure.reason, message: outcome.failure.detail } }),
            ),
          );
        else if (outcome.kind === 'unknown-prompt')
          controller.enqueue(
            encoder.encode(
              frame('result', {
                requestId,
                error: {
                  code: 'UNKNOWN_PROMPT',
                  message: `no frozen create prompt named ${promptId}`,
                  field: 'promptId',
                },
              }),
            ),
          );
        else controller.enqueue(encoder.encode(frame('result', { requestId, ...outcome.body })));

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        // Bez tohohle si obrácený proxy pár rámců schová do vyrovnávací paměti
        // a průběh dorazí naráz s verdiktem — tedy k ničemu.
        'x-accel-buffering': 'no',
      },
    });
  });
}
