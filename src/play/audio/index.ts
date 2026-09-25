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

import { type ArcadeEffect, BODY, HEADER, bodyBase } from '@/play/arcade/contract';

import { ZZFX_RATE, type ZzfxParams, zzfxSamples } from './zzfx';

/** Vypínač celé vrstvy (rollback plánu P28C): `false` = hry mlčí, tlačítko ztlumení zmizí. */
export const PLAY_SFX = true;

export type SfxPreset = 'jump' | 'pickup' | 'hit' | 'win' | 'lose';

/** Náhoda 0: tentýž zvuk pokaždé, vzorky jdou uložit. */
export const SFX_PRESETS: Readonly<Record<SfxPreset, ZzfxParams>> = {
  jump: [0.5, 0, 260, 0.01, 0.03, 0.09, 1, 1, 9],
  pickup: [0.6, 0, 1180, 0, 0.03, 0.12, 1, 1, 0, 0, 520, 0.04],
  hit: [0.8, 0, 140, 0, 0.05, 0.2, 4, 1, -3, 0, 0, 0, 0, 0.8],
  win: [0.7, 0, 523, 0.02, 0.22, 0.35, 0, 1, 0, 0, 262, 0.1, 0.11],
  lose: [0.7, 0, 330, 0.02, 0.2, 0.5, 2, 1, -3],
};

/**
 * Co zazní za efekty jednoho tiku. Konec hry přehluší zbytek tiku (poslední
 * sebrání a výhra jsou jeden zvuk, ne dva přes sebe); jinak sebrání a zásah,
 * každý nejvýš jednou.
 */
export function presetsFor(events: readonly ArcadeEffect[]): SfxPreset[] {
  const kinds = new Set(events.map((event) => event.kind));
  if (kinds.has('lose')) return ['lose'];
  if (kinds.has('win')) return ['win'];
  const out: SfxPreset[] = [];
  if (kinds.has('score')) out.push('pickup');
  if (kinds.has('damage')) out.push('hit');
  return out;
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
  for (const listener of muteListeners) listener();
}

export function subscribeMuted(listener: () => void): () => void {
  muteListeners.add(listener);
  return () => muteListeners.delete(listener);
}

/** Kontext až z gesta hráče; pozastavený (iOS, skrytá záložka) se probudí. */
export function unlockAudio(): void {
  if (!PLAY_SFX) return;
  if (context === null && typeof AudioContext !== 'undefined') context = new AudioContext();
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
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
}

export function playSfx(preset: SfxPreset): void {
  play(preset, SFX_PRESETS[preset]);
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
    window.__playAudio = { state: () => context?.state ?? 'none', muted: isMuted };
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
    __playAudio?: { state: () => string; muted: () => boolean };
  }
}
