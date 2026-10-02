/**
 * Zvuk her (P28C T2): pět procedurálních zvuků ZzFX, jeden líný
 * `AudioContext` a globální ztlumení.
 *
 * Prohlížeč pustí zvuk až po gestu hráče – kontext vznikne a `resume()` se
 * zavolá na prvním `pointerdown`/`keydown` (`installSoundControls`). M
 * přepíná ztlumení, které přežije načtení stránky v `localStorage`; anonymní
 * okno nebo zakázané úložiště ztlumení jen nezapamatuje. Nic z toho nesahá do
 * relace ani do hashe – zvuk je ozdoba mimo stav.
 */

import { type ArcadeEffect, BODY, BUTTON, HEADER, type InputEvent, bodyBase } from '@/play/arcade/contract';
import type { LookId } from '@/play/arcade/look';

import { type SoundEvent, musicEnabled, sfxFor } from './library';
import { ZZFX_RATE, type ZzfxParams, zzfxSamples } from './zzfx';

/** Vypínač celé vrstvy (rollback plánu P28C): `false` = hry mlčí, tlačítko ztlumení zmizí. */
export const PLAY_SFX = true;

/** Pět událostí, které mohou mít vlastní soubor podle looku (`SoundEvent`), a zvuky akcí jen ze ZzFX (P36C T3). */
export type SfxPreset = SoundEvent | 'lane' | 'slide' | 'shoot' | 'swing' | 'combo';

const FILE_EVENTS: readonly SoundEvent[] = ['jump', 'pickup', 'hit', 'win', 'lose'];
const hasFile = (preset: SfxPreset): preset is SoundEvent => (FILE_EVENTS as readonly SfxPreset[]).includes(preset);

/** Náhoda 0: tentýž zvuk pokaždé, vzorky jdou uložit. */
export const SFX_PRESETS: Readonly<Record<SfxPreset, ZzfxParams>> = {
  jump: [0.5, 0, 260, 0.01, 0.03, 0.09, 1, 1, 9],
  pickup: [0.6, 0, 1180, 0, 0.03, 0.12, 1, 1, 0, 0, 520, 0.04],
  hit: [0.8, 0, 140, 0, 0.05, 0.2, 4, 1, -3, 0, 0, 0, 0, 0.8],
  win: [0.7, 0, 523, 0.02, 0.22, 0.35, 0, 1, 0, 0, 262, 0.1, 0.11],
  // Jemný „sting“: dva klesající tóny sinusem, žádná pila – prohra nemá trestat ucho.
  lose: [0.55, 0, 392, 0.02, 0.12, 0.42, 0, 1, -0.6, 0, -98, 0.14],
  // Akce hráče (P36C T3): krátké a tišší než události, ať je přehluší sebrání i zásah.
  lane: [0.35, 0, 620, 0, 0.01, 0.05, 1, 1, 6],
  slide: [0.4, 0, 180, 0.01, 0.06, 0.12, 4, 1, -2, 0, 0, 0, 0, 0.4],
  shoot: [0.45, 0, 880, 0, 0.02, 0.08, 2, 1, -18],
  swing: [0.45, 0, 300, 0.01, 0.03, 0.1, 4, 1, 4, 0, 0, 0, 0, 0.6],
  combo: [0.5, 0, 784, 0, 0.04, 0.14, 1, 1, 0, 0, 392, 0.05],
};

/**
 * Co zazní za efekty jednoho tiku. Konec hry přehluší zbytek tiku (poslední
 * sebrání a výhra jsou jeden zvuk, ne dva přes sebe); jinak sebrání, kombo
 * a zásah, každý nejvýš jednou. Druhy jako řetězce: `combo` vystaví jádro až
 * s P36A a smlouva efektů ho zatím nezná.
 */
export function presetsFor(events: readonly ArcadeEffect[]): SfxPreset[] {
  const kinds = new Set<string>(events.map((event) => event.kind));
  if (kinds.has('lose')) return ['lose'];
  if (kinds.has('win')) return ['win'];
  const out: SfxPreset[] = [];
  if (kinds.has('score')) out.push('pickup');
  if (kinds.has('combo')) out.push('combo');
  if (kinds.has('damage')) out.push('hit');
  return out;
}

/**
 * Zvuky akcí hráče (P36C T3) ze záznamu vstupu od indexu `from` – změna pruhu
 * ani švih nic nesebere, efekt pravidla po nich nezůstane. Zní jen náběžná
 * hrana: držené tlačítko jde do záznamu každý tik a mezera v záznamu znamená
 * puštění. Tlačítko znamená v každém ovládání něco jiného, proto podle `control`
 * (ťuk běžce je skok se zvukem `jump`, šipka dolů závodu je brzda, ne skluz).
 */
export function actionPresets(control: string, inputs: readonly InputEvent[], from: number): SfxPreset[] {
  const out = new Set<SfxPreset>();
  for (let index = Math.max(0, from); index < inputs.length; index += 1) {
    const event = inputs[index] as InputEvent;
    const before = index > 0 && (inputs[index - 1] as InputEvent).tick === event.tick - 1 ? (inputs[index - 1] as InputEvent).buttons : 0;
    const pressed = event.buttons & ~before;
    if (control === 'runner' && (pressed & (BUTTON.LEFT | BUTTON.RIGHT)) !== 0) out.add('lane');
    if (control === 'runner' && (pressed & (BUTTON.DOWN | BUTTON.HOLD)) !== 0) out.add('slide');
    if ((pressed & BUTTON.FIRE) !== 0 || (control === 'shooter' && (pressed & BUTTON.TAP) !== 0)) out.add('shoot');
    if ((pressed & BUTTON.ATTACK) !== 0 || (control === 'duel' && (pressed & BUTTON.TAP) !== 0)) out.add('swing');
  }
  return [...out];
}

/** Vibrace podle zvuku (ms nebo vzor zap/vyp); akce hráče se necítí, jen co se mu stalo. */
export const HAPTICS = {
  hit: 30,
  pickup: 10,
  win: [40, 60, 40, 60, 120],
  lose: [180, 80, 260],
} as const satisfies Partial<Record<SfxPreset, number | readonly number[]>>;

/** Od nejsilnějšího: jedno zavibrování za tik, nový vzor stejně ruší předchozí. */
const HAPTIC_ORDER = ['lose', 'win', 'hit', 'pickup'] as const;

type Vibrating = { readonly vibrate?: (pattern: number | number[]) => boolean };

/**
 * Haptika zvuků jednoho tiku (P36C T3). Jen kde prohlížeč Vibration API má
 * (iOS Safari ne – tam nic) a ne při ztlumení: kdo ztlumil hru, nechce ani bzučení.
 */
export function vibrateFor(presets: readonly SfxPreset[], device: Vibrating | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  const strongest = HAPTIC_ORDER.find((preset) => presets.includes(preset));
  if (strongest === undefined || typeof device?.vibrate !== 'function' || isMuted()) return false;
  const pattern = HAPTICS[strongest];
  return device.vibrate(typeof pattern === 'number' ? pattern : [...pattern]);
}

/**
 * Skok není efekt pravidla, je to ovládání: hráčova rychlost vzhůru v tiku
 * skočila z klidu nebo pádu nad nulu. Gravitace ji jen ubírá, takže to umí
 * jen odraz – skok, mávnutí, dupnutí na nepřítele.
 */
export function jumped(prev: Int32Array, state: Int32Array): boolean {
  const vy = bodyBase(state[HEADER.player] as number) + BODY.vy;
  return (prev[vy] as number) <= 0 && (state[vy] as number) > 0;
}

export const MUTE_KEY = 'play:sound';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function browserStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let context: AudioContext | null = null;
let muted: boolean | null = null;
const buffers = new Map<string, AudioBuffer>();
const muteListeners = new Set<() => void>();

export function isMuted(): boolean {
  if (muted === null) {
    try {
      muted = browserStore()?.getItem(MUTE_KEY) === 'muted';
    } catch {
      muted = false;
    }
  }
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    browserStore()?.setItem(MUTE_KEY, value ? 'muted' : 'on');
  } catch {
    // Plné nebo zakázané úložiště: ztlumení platí do konce stránky.
  }
  if (music !== null) music.gain.gain.value = value ? 0 : MUSIC_VOLUME;
  if (value) stopNarration();
  for (const listener of muteListeners) listener();
}

export function subscribeMuted(listener: () => void): () => void {
  muteListeners.add(listener);
  return () => muteListeners.delete(listener);
}

/** Kontext až z gesta hráče; pozastavený (iOS, skrytá záložka) se probudí. */
export function unlockAudio(): void {
  if (!PLAY_SFX) return;
  if (context === null && typeof AudioContext !== 'undefined') {
    context = new AudioContext();
    // Soubory hudby a zvuků se stahují až s běžícím kontextem – tedy po gestu, nikdy s prvním snímkem.
    context.addEventListener('statechange', whenRunning);
    whenRunning();
  }
  if (context?.state === 'suspended') void context.resume();
}

function play(key: string, params: ZzfxParams): void {
  if (!PLAY_SFX || context === null || context.state !== 'running' || isMuted()) return;
  let buffer = buffers.get(key);
  if (buffer === undefined) {
    const samples = zzfxSamples(params);
    buffer = context.createBuffer(1, samples.length, ZZFX_RATE);
    buffer.getChannelData(0).set(samples);
    buffers.set(key, buffer);
  }
  playBuffer(buffer);
}

function playBuffer(buffer: AudioBuffer): void {
  if (context === null) return;
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
}

/* P29D T5: vlastní zvuky a hudba hry ze souborů; dokud soubor není dekódovaný nebo chybí, zní ZzFX. */

const MUSIC_VOLUME = 0.35;
const files = new Map<string, AudioBuffer | 'loading' | 'missing'>();
let soundLook: LookId | null = null;
let wantedMusic: string | null = null;
let music: { readonly url: string; readonly source: AudioBufferSourceNode; readonly gain: GainNode } | null = null;

function whenRunning(): void {
  if (context?.state !== 'running') return;
  preloadLook();
  syncMusic();
  syncNarration();
}

function load(url: string): void {
  if (context === null || context.state !== 'running' || files.has(url)) return;
  files.set(url, 'loading');
  const ctx = context;
  fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return response.arrayBuffer();
    })
    .then((data) => ctx.decodeAudioData(data))
    .then(
      (buffer) => {
        files.set(url, buffer);
        if (url === wantedMusic) syncMusic();
        if (url === wantedNarration) syncNarration();
      },
      () => files.set(url, 'missing'),
    );
}

function preloadLook(): void {
  if (soundLook === null) return;
  for (const preset of FILE_EVENTS) {
    const url = sfxFor(soundLook, preset);
    if (url !== null) load(url);
  }
}

/** Look hry, jejíž zvuky hrají (ve feedu ta aktivní). `null` = jen ZzFX. */
export function setSoundLook(look: LookId | null): void {
  soundLook = look;
  preloadLook();
}

export function playSfx(preset: SfxPreset): void {
  const url = soundLook === null || !hasFile(preset) ? null : sfxFor(soundLook, preset);
  const file = url === null ? undefined : files.get(url);
  if (typeof file === 'object' && context?.state === 'running' && !isMuted()) playBuffer(file);
  else play(preset, SFX_PRESETS[preset]);
}

function syncMusic(): void {
  if (music !== null && music.url !== wantedMusic) {
    music.source.stop();
    music.source.disconnect();
    music.gain.disconnect();
    music = null;
  }
  if (wantedMusic === null || music !== null || context === null || context.state !== 'running') return;
  const file = files.get(wantedMusic);
  if (file === undefined) load(wantedMusic);
  if (typeof file !== 'object') return;
  const gain = context.createGain();
  gain.gain.value = isMuted() ? 0 : MUSIC_VOLUME;
  gain.connect(context.destination);
  const source = context.createBufferSource();
  source.buffer = file;
  source.loop = true;
  source.connect(gain);
  source.start();
  music = { url: wantedMusic, source, gain };
}

/**
 * Smyčka hry hraje, dokud nezavoláš vrácenou funkci. Bez gesta jen čeká –
 * stáhne a spustí se s prvním klepnutím. Poslední volající vyhrává (feed).
 */
export function playMusic(url: string | null): () => void {
  if (!PLAY_SFX || !musicEnabled() || url === null) return () => {};
  wantedMusic = url;
  syncMusic();
  return () => {
    if (wantedMusic !== url) return;
    wantedMusic = null;
    syncMusic();
  };
}

/*
 * P29D T11: cíl hry přečtený hlasem vypravěče. Jednou za stránku, až po gestu
 * a jen když je nahrávka hotová – dveře bez ní vrátí 204, dekódování selže a
 * hra mlčí. Ztlumení ji zastaví a ztlumená hra ji vůbec nespustí.
 */

let wantedNarration: string | null = null;
let narration: { readonly url: string; readonly source: AudioBufferSourceNode } | null = null;
const narrated = new Set<string>();

function stopNarration(): void {
  if (narration === null) return;
  narration.source.stop();
  narration.source.disconnect();
  narration = null;
}

function syncNarration(): void {
  if (narration !== null && narration.url !== wantedNarration) stopNarration();
  const url = wantedNarration;
  if (url === null || narrated.has(url) || context === null || context.state !== 'running' || isMuted()) return;
  const file = files.get(url);
  if (file === undefined) load(url);
  if (typeof file !== 'object') return;
  narrated.add(url);
  const source = context.createBufferSource();
  source.buffer = file;
  source.connect(context.destination);
  source.addEventListener('ended', () => {
    if (narration?.source === source) narration = null;
  });
  source.start();
  narration = { url, source };
}

/** Přečte cíl hry z `url` (viz `narrationUrl`); vrácená funkce ho utne. Bez gesta čeká jako hudba. */
export function playNarration(url: string | null): () => void {
  if (!PLAY_SFX || url === null) return () => {};
  wantedNarration = url;
  syncNarration();
  return () => {
    if (wantedNarration !== url) return;
    wantedNarration = null;
    syncNarration();
  };
}

/** Krátký čistý tón (pípnutí rytmu na beat a při trefě). */
export function playTone(frequency: number, volume: number): void {
  play(`tone:${frequency}:${volume}`, [volume * 3, 0, frequency, 0, 0, 0.12]);
}

/** Klávesa do pole formuláře zvuk nepřepne – píše se tam věta. */
const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null);

let installed = 0;
let removeControls: (() => void) | null = null;

/**
 * Probuzení zvuku gestem a klávesa M. Feed drží několik her naráz – posluchače
 * jsou na stránce jen jednou, jinak by M přepnulo tolikrát, kolik her běží.
 */
export function installSoundControls(): () => void {
  installed += 1;
  if (installed === 1 && typeof window !== 'undefined') {
    const onPointer = (): void => unlockAudio();
    const onKey = (event: KeyboardEvent): void => {
      if (typing(event.target)) return;
      if (event.key.toLowerCase() === 'm' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey) setMuted(!isMuted());
      unlockAudio();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    window.__playAudio = {
      state: () => context?.state ?? 'none',
      muted: isMuted,
      music: () => music?.url ?? null,
      musicGain: () => music?.gain.gain.value ?? null,
      narration: () => narration?.url ?? null,
      narrated: () => [...narrated],
      loaded: () => [...files].filter(([, file]) => typeof file === 'object').map(([url]) => url),
    };
    removeControls = () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
      delete window.__playAudio;
    };
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    installed -= 1;
    if (installed === 0) {
      removeControls?.();
      removeControls = null;
    }
  };
}

declare global {
  interface Window {
    /** Sonda e2e: stav `AudioContext` (`none`, dokud nevznikl) a ztlumení. */
    __playAudio?: { state: () => string; muted: () => boolean; music: () => string | null; musicGain: () => number | null; narration: () => string | null; narrated: () => string[]; loaded: () => string[] };
  }
}
