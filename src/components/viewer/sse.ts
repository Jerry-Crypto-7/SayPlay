/**
 * Průběh emise po SSE — čtečka nad `fetch` pro starý kontrakt `/api/emit`.
 *
 * `EventSource` se sem nehodí: umí jen GET, a emise se vyvolává POSTem
 * s `promptId`. Zbývá `fetch` a ruční dekódování `text/event-stream`, což je
 * shodou okolností ta lepší polovina — dekodér je čistá funkce a dá se na něj
 * ptát v Node bez prohlížeče i bez serveru.
 *
 * ## Dekodér se odstěhoval, kontrakt zůstal
 *
 * `SseDecoder` bydlí od P15 T17 v `src/worldstream/client.ts` a tenhle soubor
 * ho **re-exportuje**. Důvod je naměřený, ne estetický: importovala si ho
 * odsud čtyři místa mimo viewer (`stream.test.ts`, `sessions.test.ts`,
 * `e2e/worldstream-session.spec.ts` a nově proud relace), takže to nikdy nebyl
 * kus UI, ale sdílený dekodér drátu na špatné adrese. Dva dekodéry vedle sebe
 * by se časem rozešly právě v tom, co je na nich těžké — v držení zbytku mezi
 * síťovými kusy. Import `from './sse'` proto platí dál a pro volající se
 * nemění nic.
 */

export { SseDecoder, type SseFrame } from '../../worldstream/client';

import { SseDecoder } from '../../worldstream/client';

/** Fáze, které projde `POST /api/emit`. Jména jsou stejná jako `rejection.stage`. */
export type EmitPhase = 'requested' | 'emitted' | 'schema' | 'references' | 'look' | 'lowering' | 'witness';

export interface EmitProgress {
  readonly phase: EmitPhase;
  /**
   * Pořadí v rámci jednoho běhu, ne čas. Wall clock by z průběhu udělal
   * veličinu, která se při každém běhu liší, a nedal by se pinovat v testu.
   */
  readonly step: number;
}

export interface EmissionStream {
  /** Verdikt endpointu — tentýž objekt, jaký vrací `POST /api/emit`. */
  readonly result: unknown;
  /** Fáze v pořadí, v jakém dorazily. */
  readonly progress: readonly EmitProgress[];
}

/**
 * Vyvolá emisi a čte její průběh. `onProgress` je volaný na každý rámec,
 * takže viewer může kreslit postup dřív, než dorazí verdikt.
 */
export async function streamEmission(
  promptId: string,
  options: { readonly onProgress?: (progress: EmitProgress) => void; readonly signal?: AbortSignal } = {},
): Promise<EmissionStream> {
  const response = await fetch('/api/emit/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ promptId }),
    signal: options.signal,
  });

  // Chybové stavy (400, 408, 413) odcházejí jako JSON, ne jako proud rámců.
  // Bez téhle kontroly se dekóduje nula rámců a volající dostane `result: null`,
  // tedy „emise doběhla a nic nevrátila" místo „požadavek byl odmítnut".
  if (!response.ok) throw new Error(`emisní kanál odmítl požadavek: HTTP ${response.status}`);
  if (response.body === null) throw new Error('emisní kanál nedodal tělo');

  const decoder = new SseDecoder();
  const text = new TextDecoder();
  const reader = response.body.getReader();
  const progress: EmitProgress[] = [];
  let result: unknown = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of decoder.push(text.decode(value, { stream: true }))) {
      if (frame.event === 'progress') {
        const step = JSON.parse(frame.data) as EmitProgress;
        progress.push(step);
        options.onProgress?.(step);
      } else if (frame.event === 'result') {
        result = JSON.parse(frame.data);
      }
    }
  }

  return { result, progress };
}
