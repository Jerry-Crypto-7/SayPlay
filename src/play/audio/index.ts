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
import type { HeroAction } from '@/play/spec';

import { type SoundEvent, musicEnabled, sfxFor } from './library';
import { ZZFX_RATE, type ZzfxParams, zzfxSamples } from './zzfx';

/** Vypínač celé vrstvy (rollback plánu P28C): `false` = hry mlčí, tlačítko ztlumení zmizí. */
export const PLAY_SFX = true;

/**
 * Pět událostí, které mohou mít vlastní soubor podle looku (`SoundEvent`), zvuky akcí
 * jen ze ZzFX (P36C T3) a zvuky událostí sběrnice efektů, které dřív bylo jen vidět (P37B T5):
 * dopad, zánik nepřítele, zrod těla, změna stavu cíle a zásah jiného těla než hráče.
 */
export type SfxPreset = SoundEvent | 'lane' | 'slide' | 'shoot' | 'swing' | 'combo' | 'land' | 'pop' | 'spawn' | 'chime' | 'strike' | 'powerup' | 'bossDown' | 'comboUp';

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
  // Události sběrnice (P37B T5): tišší než sebrání a zásah, dopad a zrod jen ťuknou.
  land: [0.3, 0, 90, 0, 0.02, 0.08, 0, 1, -2, 0, 0, 0, 0, 0.3],
  pop: [0.4, 0, 420, 0, 0.02, 0.1, 1, 1, -12, 0, 0, 0, 0, 0.2],
  spawn: [0.25, 0, 300, 0.03, 0.05, 0.1, 0, 1, 8],
  chime: [0.4, 0, 659, 0, 0.05, 0.25, 0, 1, 0, 0, 330, 0.06],
  strike: [0.45, 0, 220, 0, 0.03, 0.1, 4, 1, -6, 0, 0, 0, 0, 0.5],
  // Juice (P46C T4): power-up stoupá dvěma skoky, padlý boss dlouze zaduní, kombo o tón výš cinkne.
  powerup: [0.55, 0, 523, 0.01, 0.08, 0.18, 1, 1, 0, 0, 262, 0.05, 0.05],
  bossDown: [0.75, 0, 110, 0.01, 0.12, 0.45, 4, 1, -2, 0, 0, 0, 0, 0.7],
  comboUp: [0.45, 0, 988, 0, 0.03, 0.1, 1, 1, 0, 0, 494, 0.03],
};

/**
 * Zvuk činnosti hrdiny (P37B T5) – zní s nápřahem, který spustí efekt jádra
 * (`HeroActionBody`), ne v klidové smyčce: pracovní takt by za hru zněl desítkykrát.
 * Krátké a tiché pod zvukem sebrání, který zazní ve stejném tiku.
 */
export const HERO_ACTION_SFX: Readonly<Record<Exclude<HeroAction, 'none'>, ZzfxParams>> = {
  // Míchání: bublavé zhoupnutí nízkého tónu.
  stir: [0.3, 0, 180, 0.02, 0.08, 0.1, 0, 1, 0, 0, 0, 0, 0, 0, 12],
  // Hadice: šum, který odezní.
  spray: [0.25, 0, 900, 0.01, 0.12, 0.12, 4, 1, 0, 0, 0, 0, 0, 1],
  // Skládání: dvě dřevěná klapnutí.
  stack: [0.35, 0, 520, 0, 0.01, 0.05, 1, 1, 0, 0, 0, 0, 0.07],
  carry: [0.3, 0, 140, 0.01, 0.03, 0.1, 0, 1, 3],
  sweep: [0.22, 0, 1400, 0.03, 0.08, 0.1, 4, 1, -20, 0, 0, 0, 0, 1],
  throw: [0.3, 0, 500, 0.02, 0.05, 0.08, 4, 1, 30, 0, 0, 0, 0, 0.6],
  dig: [0.35, 0, 110, 0, 0.04, 0.1, 4, 1, -4, 0, 0, 0, 0, 0.8],
  // Štětec: měkké mlasknutí.
  paint: [0.3, 0, 260, 0, 0.03, 0.08, 0, 1, -18, 0, 0, 0, 0, 0.4],
  // Sekera: ostré „tuk“ do dřeva.
  chop: [0.45, 0, 330, 0, 0.01, 0.07, 2, 1, -20, 0, 0, 0, 0, 0.6],
  water: [0.25, 0, 700, 0.02, 0.1, 0.15, 0, 1, -6, 0, 0, 0, 0, 0.3, 4],
  knit: [0.25, 0, 1600, 0, 0.005, 0.03, 1, 1, 0, 0, 0, 0, 0.05],
  // Klíč: kovové cinknutí.
  fix: [0.35, 0, 1250, 0, 0.02, 0.15, 3, 1, 0, 0, 0, 0, 0, 0, 0.5],
};

export function playHeroActionSfx(action: HeroAction): void {
  if (action === 'none') return;
  play(`action:${action}`, HERO_ACTION_SFX[action]);
}

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
  // Naplánovaný náběh nebo ztišení by holé přiřazení přebily – nejdřív pryč, pak hned nová hodnota.
  if (music !== null) {
    music.gain.gain.cancelScheduledValues(context?.currentTime ?? 0);
    music.gain.gain.value = value ? 0 : MUSIC_VOLUME;
  }
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

/** Bod události ve hře (m, osy jádra), odkud zvuk zní (P67 T8). */
export type SoundAt = { readonly x: number; readonly y: number; readonly z: number };

/**
 * Cesta zvuku ve VR (P67 T8): `null` = každý zvuk jde rovnou do `destination` a poloha se pomine. V relaci VR ji
 * dosadí `XrAudio` (chunk XR): zvuk s polohou pustí přes panner, bez polohy rovnou do `destination`.
 */
export const spatial: { route: ((context: AudioContext, source: AudioBufferSourceNode, at?: SoundAt) => void) | null } = { route: null };

function play(key: string, params: ZzfxParams, at?: SoundAt): void {
  if (!PLAY_SFX || context === null || context.state !== 'running' || isMuted()) return;
  let buffer = buffers.get(key);
  if (buffer === undefined) {
    const samples = zzfxSamples(params);
    buffer = context.createBuffer(1, samples.length, ZZFX_RATE);
    buffer.getChannelData(0).set(samples);
    buffers.set(key, buffer);
  }
  playBuffer(buffer, at);
}

function playBuffer(buffer: AudioBuffer, at?: SoundAt): void {
  if (context === null) return;
  const source = context.createBufferSource();
  source.buffer = buffer;
  if (spatial.route === null) source.connect(context.destination);
  else spatial.route(context, source, at);
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
        if (url === musicUrl()) syncMusic();
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

/**
 * Týž zvuk dřív než za tohle (ms) nezazní znovu. Události tiku slyší dvě cesty –
 * efekty jádra (`presetsFor`) a sběrnice efektů (`busPresets`) – a sebrání,
 * zásah, výhra i prohra by jinak zněly dvakrát přes sebe. Je to méně než dva
 * tiky (33 ms), takže sebrání v příštím tiku zazní.
 */
export const SFX_REPEAT_MS = 30;
const lastSfx = new Map<SfxPreset, number>();

/** `at` = odkud zní (P67 T8); platí jen ve VR, kde zvuk s polohou projde i po témže bez ní – ten utne `spatial.route`. */
export function playSfx(preset: SfxPreset, at?: SoundAt): void {
  const now = typeof performance === 'undefined' ? Date.now() : performance.now();
  const last = lastSfx.get(preset);
  if (last !== undefined && now - last < SFX_REPEAT_MS && (at === undefined || spatial.route === null)) return;
  lastSfx.set(preset, now);
  if (preset === 'win' || preset === 'lose') duckMusic();
  const url = soundLook === null || !hasFile(preset) ? null : sfxFor(soundLook, preset);
  const file = url === null ? undefined : files.get(url);
  if (typeof file === 'object' && context?.state === 'running' && !isMuted()) playBuffer(file, at);
  else play(preset, SFX_PRESETS[preset], at);
}

/*
 * P37B T5: hudba sleduje napětí hry. Hra má klidnou (nebo podle nálady napjatou)
 * smyčku a k ní napjatou smyčku téhož looku; `setMusicTension` mezi nimi
 * prolne (`MUSIC_FADE_S`). Výhra a prohra hudbu na chvíli ztiší pod svůj zvuk.
 */

/** Prolnutí smyček (s). */
export const MUSIC_FADE_S = 0.8;
/** Ztišení pod výhrou a prohrou: na tuhle část hlasitosti, na `DUCK_HOLD_S`, pak zpět za `DUCK_BACK_S`. */
export const MUSIC_DUCK = 0.25;
const DUCK_HOLD_S = 1.4;
const DUCK_BACK_S = 0.8;

let wantedTense: string | null = null;
let tension = false;

/** Smyčka, která má hrát: napjatá, když hra je v napětí a look ji má. */
const musicUrl = (): string | null => (tension && wantedTense !== null ? wantedTense : wantedMusic);

/** Plynulá změna hlasitosti; naplánované kroky (ztišení) se zahodí. */
function rampTo(param: AudioParam, value: number, seconds: number): void {
  if (context === null) return;
  const now = context.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(value, now + seconds);
}

function duckMusic(): void {
  if (music === null || context === null || isMuted()) return;
  const param = music.gain.gain;
  const now = context.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(MUSIC_VOLUME * MUSIC_DUCK, now + 0.08);
  param.setValueAtTime(MUSIC_VOLUME * MUSIC_DUCK, now + DUCK_HOLD_S);
  param.linearRampToValueAtTime(MUSIC_VOLUME, now + DUCK_HOLD_S + DUCK_BACK_S);
}

function syncMusic(): void {
  const url = musicUrl();
  if (music !== null && music.url !== url) {
    // Stará smyčka dozní, nová se náběhem prolne; bez nové (konec hry) hudba utichne hned.
    const old = music;
    const fade = url === null ? 0.05 : MUSIC_FADE_S;
    rampTo(old.gain.gain, 0, fade);
    old.source.stop((context?.currentTime ?? 0) + fade);
    old.source.onended = () => old.gain.disconnect();
    music = null;
  }
  if (url === null || music !== null || context === null || context.state !== 'running') return;
  const file = files.get(url);
  if (file === undefined) load(url);
  if (typeof file !== 'object') return;
  const gain = context.createGain();
  gain.gain.value = 0;
  gain.connect(context.destination);
  rampTo(gain.gain, isMuted() ? 0 : MUSIC_VOLUME, MUSIC_FADE_S);
  const source = context.createBufferSource();
  source.buffer = file;
  source.loop = true;
  source.connect(gain);
  source.start();
  music = { url, source, gain };
  // Napjatá smyčka se stáhne dopředu, ať přechod nečeká na síť.
  if (wantedTense !== null) load(wantedTense);
}

/**
 * Smyčka hry hraje, dokud nezavoláš vrácenou funkci. Bez gesta jen čeká –
 * stáhne a spustí se s prvním klepnutím. Poslední volající vyhrává (feed).
 * `tense` = napjatá smyčka téhož looku pro `setMusicTension` (P37B T5).
 */
export function playMusic(url: string | null, tense: string | null = null): () => void {
  if (!PLAY_SFX || !musicEnabled() || url === null) return () => {};
  wantedMusic = url;
  wantedTense = tense;
  tension = false;
  syncMusic();
  return () => {
    if (wantedMusic !== url) return;
    wantedMusic = null;
    wantedTense = null;
    tension = false;
    syncMusic();
  };
}

/** Hra je v napětí (poslední život, poslední sekundy, soupeř blízko) – hudba přejde do napjaté smyčky. */
export function setMusicTension(on: boolean): void {
  if (tension === on) return;
  tension = on;
  syncMusic();
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

const GESTURES = ['pointerdown', 'pointerup', 'touchend'] as const;

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
    // Prst je gesto až při zvednutí (HTML „activation-triggering input event“) – bez `pointerup` a `touchend`
    // by iPhone kontext z `pointerdown` nepustil (P58C T4). Myš dává gesto už stiskem.
    for (const type of GESTURES) window.addEventListener(type, onPointer, true);
    window.addEventListener('keydown', onKey, true);
    window.__playAudio = {
      state: () => context?.state ?? 'none',
      muted: isMuted,
      music: () => music?.url ?? null,
      musicGain: () => music?.gain.gain.value ?? null,
      tension: () => tension,
      narration: () => narration?.url ?? null,
      narrated: () => [...narrated],
      loaded: () => [...files].filter(([, file]) => typeof file === 'object').map(([url]) => url),
    };
    removeControls = () => {
      for (const type of GESTURES) window.removeEventListener(type, onPointer, true);
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
    __playAudio?: { state: () => string; muted: () => boolean; music: () => string | null; musicGain: () => number | null; tension: () => boolean; narration: () => string | null; narrated: () => string[]; loaded: () => string[] };
  }
}
