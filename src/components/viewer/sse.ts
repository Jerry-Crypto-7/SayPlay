/**
 * Průběh emise po SSE — dekodér rámců a čtečka nad `fetch`.
 *
 * `EventSource` se sem nehodí: umí jen GET, a emise se vyvolává POSTem
 * s `promptId`. Zbývá `fetch` a ruční dekódování `text/event-stream`, což je
 * shodou okolností ta lepší polovina — dekodér je čistá funkce a dá se na něj
 * ptát v Node bez prohlížeče i bez serveru.
 *
 * Dekodér drží zbytek mezi voláními, protože rámec se běžně rozpadne přes dva
 * síťové kusy. Rozpad uprostřed `data:` řádku je stav, který nastane v provozu
 * a v testu nikdy, když si test podává celé rámce — proto na něj `sse.test.ts`
 * míří výslovně.
 */

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

export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

/** Rámce z `text/event-stream`, po kusech tak, jak dorazí ze sítě. */
export class SseDecoder {
  private buffer = '';

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];

    // Rámec končí prázdným řádkem. `\r\n` i `\n` — spec připouští obojí.
    const boundary = /\r?\n\r?\n/;
    let split = boundary.exec(this.buffer);
    while (split !== null) {
      const block = this.buffer.slice(0, split.index);
      this.buffer = this.buffer.slice(split.index + split[0].length);
      const frame = decodeBlock(block);
      if (frame !== null) frames.push(frame);
      split = boundary.exec(this.buffer);
    }

    return frames;
  }
}

function decodeBlock(block: string): SseFrame | null {
  let event = 'message';
  const data: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Jedna mezera za dvojtečkou patří formátu, ne hodnotě.
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;

    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  return data.length === 0 ? null : { event, data: data.join('\n') };
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
