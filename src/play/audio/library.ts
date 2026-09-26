/**
 * Vlastní hudba a zvuky každé hry (P29D T5): předgenerovaná knihovna podle
 * vzhledu hry (`lookOf(theme)`) a nálady. Čisté funkce – co se hraje, rozhoduje
 * tenhle soubor, jak se to hraje, `index.ts`.
 *
 * Katalogy píše `ops/audio/music.py` a `ops/audio/sfx.py`. Chybí-li look,
 * událost nebo celý katalog, vrátí se `null` a hra zní syntetickými ZzFX.
 */

import { type LookId, lookOf } from '@/play/arcade/look';

import musicCatalog from './music-catalog.json';
import sfxCatalog from './sfx-catalog.json';

export type MusicMood = 'calm' | 'tense';
export type SoundEvent = 'jump' | 'pickup' | 'hit' | 'win' | 'lose';

export type MusicCatalog = { readonly loops: Readonly<Partial<Record<string, Readonly<Partial<Record<MusicMood, string>>>>>> };
export type SfxCatalog = { readonly sounds: Readonly<Partial<Record<string, Readonly<Partial<Record<SoundEvent, string>>>>>> };

type Theme = { readonly setting: string; readonly mood: string; readonly look?: LookId };

const TENSE = /\b(tense|dark|scary|spooky|creepy|danger\w*|urgent|fast|frantic|angry|epic|chase\w*|panic|horror|haunted|deadly|intense|battle|war|storm\w*|fire|lava|zombie\w*|monster\w*|attack\w*)\b/i;

/** Napjatá hudba, když nálada nebo místo zní nebezpečně; jinak klidná. */
export function moodOf(theme: Theme): MusicMood {
  return TENSE.test(`${theme.mood} ${theme.setting}`) ? 'tense' : 'calm';
}

/** Smyčka pro hru, nebo `null` (hudba mlčí, ZzFX hudbu nemá). */
export function musicFor(theme: Theme, catalog: MusicCatalog = musicCatalog): string | null {
  return catalog.loops[lookOf(theme)]?.[moodOf(theme)] ?? null;
}

/** Zvuk události v daném looku, nebo `null` = syntetický ZzFX. */
export function sfxFor(look: LookId, event: SoundEvent, catalog: SfxCatalog = sfxCatalog): string | null {
  return catalog.sounds[look]?.[event] ?? null;
}

/** `PLAY_MUSIC=off` při buildu vypne hudbu; zvuky zůstanou. */
export function musicEnabled(flag: string | undefined = process.env.PLAY_MUSIC): boolean {
  return flag?.trim().toLowerCase() !== 'off';
}
