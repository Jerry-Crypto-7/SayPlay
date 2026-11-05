/**
 * Krátký klip aktivní karty feedu (P71B T2): ~3 s živého náhledu robota z trvalého plátna (`StageHost`) přes
 * `canvas.captureStream(30)` + `MediaRecorder`. Neaktivní karta pak místo statického plakátu přehrává klip (T4).
 *
 * Formát podle `MediaRecorder.isTypeSupported`: MP4/H.264 (telefon ho většinou kóduje hardwarem), jinak WebM/VP9,
 * jinak výchozí WebM prohlížeče. Klip nad 1,5 MB se zahodí. Nenahrává se při méně pohybu, na pozadí ani bez
 * `MediaRecorder` (Safari < 14.1 – karta pak ukáže plakát); nahrávání, které přestane platit (`keepGoing`), se zahodí.
 */

export const CLIP_MS = 3000;
export const CLIP_FPS = 30;
export const CLIP_MAX_BYTES = 1_500_000;
/** Náhled se po přechodu na kartu chvíli usazuje (modely, první snímky) – klip začne až po něm. */
export const CLIP_DELAY_MS = 1000;
/** Datový tok videa: 3 s ≈ 0,75 MB, pod stropem i s režií kontejneru. */
const CLIP_BITS_PER_SECOND = 2_000_000;
/** Jak často se během nahrávání ptá, jestli náhled pořád běží. */
const CHECK_MS = 200;

const TYPES = ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm'] as const;

/** Část `MediaRecorder`, kterou klip používá – test ho nahradí. */
export interface Recorder {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
  isTypeSupported(type: string): boolean;
}

/** První formát, který prohlížeč umí nahrát; `null` = žádný. */
export function clipType(recorder: Pick<Recorder, 'isTypeSupported'>): string | null {
  return TYPES.find((type) => recorder.isTypeSupported(type)) ?? null;
}

interface ClipEnv {
  readonly MediaRecorder?: Recorder;
  matchMedia(query: string): { readonly matches: boolean };
  readonly document: { readonly visibilityState: DocumentVisibilityState };
}

/** Smí se nahrávat: prohlížeč má `MediaRecorder` s některým z formátů, neprosí o méně pohybu a stránka je vidět. */
export function clipsAllowed(env: ClipEnv = window as unknown as ClipEnv): boolean {
  const recorder = env.MediaRecorder;
  if (recorder === undefined || typeof recorder.isTypeSupported !== 'function' || clipType(recorder) === null) return false;
  return !env.matchMedia('(prefers-reduced-motion: reduce)').matches && env.document.visibilityState === 'visible';
}

export interface ClipJob {
  /** Hotový klip; `null` = zrušený, prázdný, přes strop nebo prohlížeč nahrávat neumí. */
  readonly done: Promise<Blob | null>;
  cancel(): void;
}

/** Nahraje `CLIP_MS` z plátna; skončí dřív a klip zahodí, jakmile `keepGoing()` vrátí `false` nebo přijde `cancel`. */
export function recordClip(canvas: Pick<HTMLCanvasElement, 'captureStream'>, keepGoing: () => boolean, recorder: Recorder = window.MediaRecorder): ClipJob {
  let stop: (keep: boolean) => void = () => undefined;
  const done = new Promise<Blob | null>((resolve) => {
    const type = clipType(recorder);
    if (type === null) {
      resolve(null);
      return;
    }
    let stream: MediaStream;
    let media: MediaRecorder;
    try {
      stream = canvas.captureStream(CLIP_FPS);
      media = new recorder(stream, { mimeType: type, videoBitsPerSecond: CLIP_BITS_PER_SECOND });
    } catch {
      // Prohlížeč formát nahlásil, ale nahrávač odmítl (NotSupportedError): karta zůstane u plakátu.
      resolve(null);
      return;
    }
    const chunks: Blob[] = [];
    let keep = false;
    const check = setInterval(() => {
      if (!keepGoing()) stop(false);
    }, CHECK_MS);
    const end = setTimeout(() => stop(true), CLIP_MS);
    stop = (wanted) => {
      stop = () => undefined;
      keep = wanted;
      if (media.state === 'inactive') finish();
      else media.stop();
    };
    const finish = () => {
      // Nahrávač mohl skončit sám (plátno zmizelo): hlídání a konec klipu pryč, klip se zahodí (`keep` zůstal `false`).
      clearInterval(check);
      clearTimeout(end);
      stop = () => undefined;
      for (const track of stream.getTracks()) track.stop();
      const blob = new Blob(chunks, { type: media.mimeType || type });
      resolve(keep && blob.size > 0 && blob.size <= CLIP_MAX_BYTES ? blob : null);
    };
    media.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    media.onstop = finish;
    media.onerror = () => stop(false);
    media.start();
  });
  return { done, cancel: () => stop(false) };
}
