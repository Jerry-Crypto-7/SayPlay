/**
 * Přezdívka hráče na žebříčku (P44B T3). Výchozí jméno je deterministické
 * z `sha256(id)` – z bajtů id samotného by jméno prozradilo kus id (debata T1).
 * Vlastní jméno projde tvarem a moderací dřív, než se uloží, a znovu při čtení:
 * do žebříčku ani do náhledu výzvy (T7) nejde jiný text z úložiště.
 */

import { createHash } from 'node:crypto';

import { moderatePrompt, PLAY_MODERATION } from '@/server/moderation';

const ADJECTIVES = [
  'Swift', 'Brave', 'Clever', 'Lucky', 'Quiet', 'Bold', 'Happy', 'Sunny',
  'Jolly', 'Mighty', 'Nimble', 'Rapid', 'Steady', 'Witty', 'Gentle', 'Fierce',
  'Bright', 'Calm', 'Daring', 'Eager', 'Fancy', 'Grand', 'Hasty', 'Keen',
  'Lively', 'Merry', 'Noble', 'Proud', 'Silly', 'Tiny', 'Vivid', 'Zesty',
] as const;

const ANIMALS = [
  'Otter', 'Fox', 'Panda', 'Tiger', 'Falcon', 'Badger', 'Koala', 'Lynx',
  'Moose', 'Owl', 'Rabbit', 'Seal', 'Wolf', 'Yak', 'Zebra', 'Heron',
  'Gecko', 'Bison', 'Crane', 'Dolphin', 'Eagle', 'Ferret', 'Goose', 'Hedgehog',
  'Ibis', 'Jaguar', 'Kiwi', 'Lemur', 'Marten', 'Newt', 'Puffin', 'Raven',
] as const;

export function defaultNickname(playerId: string): string {
  const digest = createHash('sha256').update(`nickname:${playerId}`).digest();
  return `${ADJECTIVES[(digest[0] as number) % ADJECTIVES.length]} ${ANIMALS[(digest[1] as number) % ANIMALS.length]}`;
}

export const NICKNAME_MIN_CHARS = 2;
export const NICKNAME_MAX_CHARS = 20;
const NICKNAME_PATTERN = /^[\p{L}\p{N} ._-]+$/u;

export type NicknameRead = { readonly ok: true; readonly nickname: string } | { readonly ok: false; readonly reason: 'shape' | 'blocked' };

/** Jméno od hráče: po ořezu 2–20 znaků z písmen, číslic, mezery a `._-`, a moderace PLAY. */
export function readNickname(value: unknown): NicknameRead {
  if (typeof value !== 'string') return { ok: false, reason: 'shape' };
  const nickname = value.normalize('NFC').trim();
  const length = [...nickname].length;
  if (length < NICKNAME_MIN_CHARS || length > NICKNAME_MAX_CHARS || !NICKNAME_PATTERN.test(nickname)) return { ok: false, reason: 'shape' };
  if (!moderatePrompt(nickname, PLAY_MODERATION).ok) return { ok: false, reason: 'blocked' };
  return { ok: true, nickname };
}

/** Jméno, pod kterým hráč stojí na žebříčku: uložené, pokud dál projde `readNickname`, jinak výchozí. */
export function shownNickname(playerId: string, stored: string | null | undefined): string {
  const read = readNickname(stored);
  return read.ok ? read.nickname : defaultNickname(playerId);
}
