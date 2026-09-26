/**
 * Klip běhu (P29D T1): plátno hry nahrané nativním `MediaRecorder` přes
 * `captureStream` – bez závislosti (MPL knihovny `RULES.md` §4 nepustí).
 *
 * Klip musí obsahovat KONEC hry, ale nesmí být delší než `CLIP_MAX_MS`.
 * Nahrávku nejde zpětně oříznout a kousky jednoho rekordéru se samy
 * nepřehrají, proto běží dva úseky posunuté o polovinu: každý se po
 * `SEGMENT_MS` zahodí a začne znovu. Na konci hry vyhraje ten starší – je
 * dlouhý aspoň půl úseku a s dojezdem `CLIP_TAIL_MS` se vejde do stropu.
 */

/** Nejdelší klip včetně dojezdu po konci hry. */
export const CLIP_MAX_MS = 16_000;
/** Dojezd po konci běhu – plátno kreslí naplno ještě tak dlouho (`END_CLIP_MS` v `ArcadeStage`). */
export const CLIP_TAIL_MS = 1_500;
const SEGMENT_MS = CLIP_MAX_MS - CLIP_TAIL_MS;
const FPS = 30;

export interface ClipRecorderLike {
  readonly state: string;
  ondataavailable: ((event: { readonly data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface ClipDeps {
  readonly Recorder: new (stream: MediaStream, options: { mimeType: string }) => ClipRecorderLike;
  readonly isTypeSupported: (type: string) => boolean;
  readonly setTimeout: (run: () => void, ms: number) => number;
  readonly clearTimeout: (id: number) => void;
}

export interface Clip {
  /** Nahraje ještě `CLIP_TAIL_MS` a vydá klip; prázdná nahrávka je `null`. */
  finish(): Promise<Blob | null>;
  /** Zahodí nahrávku (ukázka robota, odchod ze hry). */
  cancel(): void;
}

/** MP4, kde ho rekordér umí (Safari, novější Chrome) – sdílí se všude; jinak WebM. */
export function clipType(isTypeSupported: (type: string) => boolean): 'video/mp4' | 'video/webm' | null {
  if (isTypeSupported('video/mp4')) return 'video/mp4';
  if (isTypeSupported('video/webm')) return 'video/webm';
  return null;
}

function browserDeps(): ClipDeps | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return {
    Recorder: MediaRecorder as unknown as ClipDeps['Recorder'],
    isTypeSupported: (type) => MediaRecorder.isTypeSupported(type),
    setTimeout: (run, ms) => window.setTimeout(run, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
}

interface Segment {
  readonly recorder: ClipRecorderLike;
  readonly chunks: Blob[];
  timer: number;
}

/** Začne nahrávat plátno; `null`, kde prohlížeč plátno nahrát neumí. */
export function startClip(canvas: HTMLCanvasElement, deps: ClipDeps | null = browserDeps()): Clip | null {
  if (deps === null || typeof canvas.captureStream !== 'function') return null;
  const type = clipType(deps.isTypeSupported);
  if (type === null) return null;
  let stream: MediaStream;
  try {
    stream = canvas.captureStream(FPS);
  } catch {
    return null;
  }
  const segments: Segment[] = [];
  let tail: number | undefined;
  let settle: ((blob: Blob | null) => void) | undefined;

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const track of stream.getTracks()) track.stop();
  };
  const drop = (segment: Segment): void => {
    deps.clearTimeout(segment.timer);
    segment.recorder.ondataavailable = null;
    segment.recorder.onstop = null;
    // Neaktivní rekordér na `stop` hází.
    if (segment.recorder.state !== 'inactive') segment.recorder.stop();
    segments.splice(segments.indexOf(segment), 1);
  };
  const open = (): void => {
    const recorder = new deps.Recorder(stream, { mimeType: type });
    const segment: Segment = { recorder, chunks: [], timer: 0 };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) segment.chunks.push(event.data);
    };
    recorder.start();
    segment.timer = deps.setTimeout(() => {
      drop(segment);
      open();
    }, SEGMENT_MS);
    segments.push(segment);
  };

  try {
    open();
  } catch {
    close();
    return null;
  }
  const stagger = deps.setTimeout(open, SEGMENT_MS / 2);

  return {
    finish: () =>
      new Promise((resolve) => {
        deps.clearTimeout(stagger);
        // Pole drží úseky v pořadí začátku: první je nejstarší, tedy nejdelší.
        const [keep, ...rest] = segments;
        for (const segment of rest) drop(segment);
        if (keep === undefined) {
          close();
          resolve(null);
          return;
        }
        deps.clearTimeout(keep.timer);
        settle = resolve;
        tail = deps.setTimeout(() => {
          tail = undefined;
          keep.recorder.onstop = () => {
            segments.length = 0;
            close();
            const blob = new Blob(keep.chunks, { type });
            settle = undefined;
            resolve(blob.size > 0 ? blob : null);
          };
          keep.recorder.stop();
        }, CLIP_TAIL_MS);
      }),
    cancel: () => {
      deps.clearTimeout(stagger);
      if (tail !== undefined) deps.clearTimeout(tail);
      for (const segment of [...segments]) drop(segment);
      close();
      settle?.(null);
      settle = undefined;
    },
  };
}
