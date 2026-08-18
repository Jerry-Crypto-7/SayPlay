/**
 * `POST /api/emit/stream` — kanál s průběhem.
 *
 * Nosná aserce je **shoda verdiktu s `/api/emit`**, ne to, že nějaké rámce
 * dorazily. Dvě cesty ke stejnému řetězu se rozejdou tiše: streamovaná verze
 * začne vracet o pole míň, viewer podle toho postaví scénu a nikdo se nedozví,
 * že se to liší od toho, co změřil offline běh.
 */

import { describe, expect, it } from 'vitest';

import { POST as emit } from '../route';
import { SseDecoder } from '../../../../components/viewer/sse';
import { POST as stream } from '../stream/route';

interface Collected {
  readonly status: number;
  readonly contentType: string | null;
  readonly phases: string[];
  readonly result: Record<string, unknown> | null;
}

function request(body: unknown): Request {
  return new Request('http://127.0.0.1/api/emit/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function collect(body: unknown): Promise<Collected> {
  const response = await stream(request(body));
  const contentType = response.headers.get('content-type');
  if (response.body === null) return { status: response.status, contentType, phases: [], result: null };

  const decoder = new SseDecoder();
  const reader = response.body.getReader();
  const text = new TextDecoder();
  const phases: string[] = [];
  let result: Record<string, unknown> | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of decoder.push(text.decode(value, { stream: true }))) {
      if (frame.event === 'progress') phases.push((JSON.parse(frame.data) as { phase: string }).phase);
      if (frame.event === 'result') result = JSON.parse(frame.data) as Record<string, unknown>;
    }
  }

  return { status: response.status, contentType, phases, result };
}

/** Bez `requestId`, který je z definice pokaždé jiný. */
function comparable(body: Record<string, unknown>): Record<string, unknown> {
  const { requestId: _ignored, ...rest } = body;
  return rest;
}

describe('kanál s průběhem', () => {
  it('ohlásí fáze v pořadí a skončí verdiktem', async () => {
    const collected = await collect({ promptId: 'C01' });

    expect(collected.status).toBe(200);
    expect(collected.contentType).toBe('text/event-stream; charset=utf-8');
    // Fáze jde ohlásit jen ta, která prošla — u odmítnutí je seznam kratší
    // a zbytek říká `rejection.stage` ve verdiktu.
    expect(collected.phases[0]).toBe('requested');
    expect(collected.phases).toContain('emitted');
    expect(collected.phases).toContain('schema');
    expect(collected.result).not.toBeNull();
  });

  it('průběh čísluje kroky od jedné a nepřeskakuje', async () => {
    const response = await stream(request({ promptId: 'C01' }));
    const raw = await new Response(response.body).text();
    const steps = [...raw.matchAll(/"step":(\d+)/g)].map((match) => Number(match[1]));
    expect(steps).toEqual(steps.map((_, index) => index + 1));
  });

  it('verdikt je tentýž objekt, jaký vrací /api/emit', async () => {
    // Celá zmrazená create sada, ne jeden reprezentativní prompt: rozejít se
    // umí zrovna ta větev, kterou vzorek nepokryje.
    for (const promptId of ['C01', 'C05', 'C08', 'C12', 'C14']) {
      const streamed = await collect({ promptId });
      const direct = await emit(
        new Request('http://127.0.0.1/api/emit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ promptId }),
        }),
      );

      expect(comparable(streamed.result!), promptId).toEqual(
        comparable((await direct.json()) as Record<string, unknown>),
      );
    }
  });

  it('rámce odcházejí průběžně, ne naráz na konci', async () => {
    // Bez tohohle je kanál jen na oko: řetěz je synchronní, takže by se všechny
    // rámce zařadily do fronty v jednom průchodu smyčkou událostí a průběh by
    // dorazil naráz s verdiktem. Neměří se čas, ale **kolikrát se smyčka
    // událostí protočila**, než proud skončil — to je vlastnost, ne rychlost
    // stroje.
    const response = await stream(request({ promptId: 'C01' }));
    const reader = response.body!.getReader();

    let finished = false;
    const pump = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          finished = true;
          return;
        }
      }
    })();

    let turns = 0;
    while (!finished) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      turns += 1;
    }
    await pump;

    // Fází je sedm včetně `requested`. Když se proud odbaví jedním průchodem,
    // napočítá se jeden nebo dva.
    expect(turns).toBeGreaterThan(3);
  });

  it('neznámý prompt jde jako verdikt, ne jako pád', async () => {
    const collected = await collect({ promptId: 'takovy-neni' });
    expect((collected.result as { error: { code: string } }).error.code).toBe('UNKNOWN_PROMPT');
  });

  it('nevalidní tělo odpoví 400 a vůbec nestreamuje', async () => {
    const response = await stream(request({ nope: 1 }));
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});
