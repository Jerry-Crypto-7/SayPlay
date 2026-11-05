/**
 * Krátký klip aktivní karty feedu (P71B T2): ~3 s živého náhledu robota z trvalého plátna (`StageHost`) přes
 * `canvas.captureStream(30)` + `MediaRecorder`. Neaktivní karta pak místo statického plakátu přehrává klip (T4).
 *
 * Formát podle `MediaRecorder.isTypeSupported`: MP4/H.264 (telefon ho většinou kóduje hardwarem), jinak WebM/VP9,
 * jinak výchozí WebM prohlížeče. Klip nad 1,5 MB se zahodí. Nenahrává se při méně pohybu, na pozadí ani bez
 * `MediaRecorder` (Safari < 14.1 – karta pak ukáže plakát); nahrávání, které přestane platit (`keepGoing`), se zahodí.
 *
 * Plynulost (`frameMeter`): nahrává se jen při náhledu nad `SMOOTH_FPS`. Shodí-li nahrávání plynulost, klip se zahodí
 * a zařízení už nenahrává (`markClipsSlow`). Měření 5. 11. (`evals/play/p71/feed/clip-fps.json`): bez zpomalení CPU
 * nahrávání nestojí nic (59,9 → 59,9 FPS), s emulovaným zpomalením ×2 i ×4 srazí náhled na 3–7 FPS.
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

// `avc3` nese parametry kodéru v proudu: Chromium s `avc1` hlásí chybu konzole, když se plátno během nahrávání
// zvětší (oracle P71B T5); prohlížeč bez `avc3` vezme `avc1`.
const TYPES = ['video/mp4;codecs=avc3.42E01E', 'video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm'] as const;

/** Část `MediaRecorder`, kterou klip používá – test ho nahradí. */
export interface Recorder {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
  isTypeSupported(type: string): boolean;
}

/** První formát, který prohlížeč umí nahrát; `null` = žádný. */
export function clipType(recorder: Pick<Recorder, 'isTypeSupported'>): string | null {
  return TYPES.find((type) => recorder.isTypeSupported(type)) ?? null;
}

/** Náhled pod touto plynulostí se nenahrává; nahrávání, které ho pod ni shodí, se zahodí. */
export const SMOOTH_FPS = 55;
/** Okno, ze kterého `frameMeter` bere medián snímku; plynulost platí, až je okno aspoň z poloviny plné. */
export const SMOOTH_WINDOW_MS = 500;
/** Značka v `localStorage`: nahrávání tady shodilo plynulost, zařízení už nenahrává. */
export const SLOW_KEY = 'sayplay-clips-slow';

interface ClipEnv {
  readonly MediaRecorder?: Recorder;
  matchMedia(query: string): { readonly matches: boolean };
  readonly document: { readonly visibilityState: DocumentVisibilityState };
  readonly localStorage?: Pick<Storage, 'getItem'>;
}

/** Smí se nahrávat: prohlížeč má `MediaRecorder` s některým z formátů, neprosí o méně pohybu, stránka je vidět a nahrávání tu dřív neshodilo plynulost. */
export function clipsAllowed(env: ClipEnv = window as unknown as ClipEnv): boolean {
  const recorder = env.MediaRecorder;
  if (recorder === undefined || typeof recorder.isTypeSupported !== 'function' || clipType(recorder) === null) return false;
  if (env.matchMedia('(prefers-reduced-motion: reduce)').matches || env.document.visibilityState !== 'visible') return false;
  try {
    return env.localStorage?.getItem(SLOW_KEY) !== '1';
  } catch {
    // Úložiště zakázané (soukromý režim): značka se nedá přečíst ani zapsat, plynulost hlídá `frameMeter` při každém klipu.
    return true;
  }
}

/** Nahrávání shodilo plynulost: zařízení už klipy nenahrává (karty ukazují offline klip nebo plakát). */
export function markClipsSlow(storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(SLOW_KEY, '1');
  } catch {
    // Úložiště zakázané: na této stránce hlídá `frameMeter`, příští návštěva to zkusí znovu.
  }
}

export interface FrameMeter {
  /** Medián snímku za posledních `SMOOTH_WINDOW_MS` (včetně snímku, který ještě nepřišel) odpovídá aspoň `SMOOTH_FPS`. */
  smooth(now?: number): boolean;
  stop(): void;
}

/** Měří snímky stránky přes `requestAnimationFrame`. */
export function frameMeter(raf: (tick: FrameRequestCallback) => number = requestAnimationFrame, cancel: (handle: number) => void = cancelAnimationFrame): FrameMeter {
  const frames: number[] = [];
  const tick = (now: number) => {
    frames.push(now);
    while (frames.length > 0 && now - frames[0] > SMOOTH_WINDOW_MS) frames.shift();
    handle = raf(tick);
  };
  let handle = raf(tick);
  return {
    smooth(now = performance.now()) {
      const recent = frames.filter((at) => now - at <= SMOOTH_WINDOW_MS);
      if (recent.length < 2 || now - recent[0] < SMOOTH_WINDOW_MS / 2) return false;
      // Zaseknutá stránka nové snímky nehlásí: půl okna bez snímku = neplynulá.
      if (now - recent[recent.length - 1] > SMOOTH_WINDOW_MS / 2) return false;
      const gaps = recent.slice(1).map((at, n) => at - recent[n]).sort((a, b) => a - b);
      return gaps[Math.floor(gaps.length / 2)] <= 1000 / SMOOTH_FPS;
    },
    stop: () => cancel(handle),
  };
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
