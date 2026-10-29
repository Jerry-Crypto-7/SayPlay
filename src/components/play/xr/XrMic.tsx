'use client';

/**
 * Mikrofon VR lobby (P67 T3): „Say it“ na kartě lobby nadiktuje větu do náhledu, hru spustí až „Make it!“.
 *
 * - Tlačítko je jen tam, kde prohlížeč diktování umí (`supportsDictation()` za běhu, ne podle tabulky brýlí).
 *   Diktuje prohlížeč (`startDictation`, `src/input/speech.ts`): nic placeného, žádný požadavek naší stránky.
 * - Při poslechu je na tlačítku „Cancel“ a lobby místo titulku ukáže „Listening…“. „Cancel“ poslech ukončí a co
 *   prohlížeč po `stop()` ještě dopošle, zahodí. Chyba (zamítnutý mikrofon…) jde jako věta kitu do poznámky karty.
 * - Výplň `sun` jako mikrofon kitu. Kit při nahrávání mikrofon zrajčatoví; na kartě lobby je rajčatové „Make it!“
 *   a rajčatová akce smí být na panelu jen jedna, proto poslech poznáte podle „Listening…“ a „Cancel“.
 */

import { useEffect, useRef, useState } from 'react';

import { type DictationSession, startDictation, supportsDictation } from '@/input/speech';

import type { PanelButton } from './XrPanel';

export const SAY_IT = 'Say it';
export const LISTENING = 'Listening…';
export const CANCEL = 'Cancel';

/**
 * Tytéž věty jako u mikrofonu na `/play` (`MicButton.tsx`). Společný export v `speech.ts` přidal prvnímu JS telefonu
 * 30 B (naměřeno 29. 10. 2026; větev už stojí na +847 B ze stropu ±1 kB), proto žijí i tady, v chunku XR.
 */
const failureOf = (code: string): string =>
  code === 'not-allowed' ? 'The microphone is blocked for this page. You can type instead.' : 'Dictation failed. You can type instead.';

export interface XrMicOptions {
  /** Stisk „Say it“ nic nezačne (lobby právě dělá hru); „Cancel“ funguje dál. */
  readonly blocked: boolean;
  /** Začal poslech. */
  readonly onListen: () => void;
  /** Hotový přepis, neprázdný. */
  readonly onText: (spoken: string) => void;
  /** Věta kitu pro hráče. */
  readonly onError: (message: string) => void;
}

export interface XrMic {
  /** `null` = prohlížeč diktování neumí a tlačítko na kartě není. */
  readonly button: PanelButton | null;
  readonly listening: boolean;
}

/** Relace, kterou tlačítko vede; obsluhy zrušené relace se poznají tak, že už není živá. */
interface Listen {
  session: DictationSession | null;
}

export function useXrMic(options: XrMicOptions): XrMic {
  const [available] = useState(() => supportsDictation());
  const [listening, setListening] = useState(false);
  const live = useRef<Listen | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  // Lobby zmizí (přišla hra, konec VR): poslech skončí a nic z něj už nedorazí.
  useEffect(
    () => () => {
      const now = live.current;
      live.current = null;
      now?.session?.stop();
    },
    [],
  );

  if (!available) return { button: null, listening: false };

  const press = (): void => {
    const now = live.current;
    if (now !== null) {
      live.current = null;
      setListening(false);
      now.session?.stop();
      return;
    }
    if (latest.current.blocked) return;
    const mine: Listen = { session: null };
    live.current = mine;
    latest.current.onListen();
    mine.session = startDictation({
      onText: (spoken) => {
        if (live.current === mine) latest.current.onText(spoken);
      },
      onError: (code) => {
        if (live.current === mine) latest.current.onError(failureOf(code));
      },
      onEnd: () => {
        if (live.current !== mine) return;
        live.current = null;
        setListening(false);
      },
    });
    // `start()` vyhodil: chybu už `onError` ohlásil, poslech nezačal.
    if (mine.session === null) {
      if (live.current === mine) live.current = null;
      return;
    }
    if (live.current === mine) setListening(true);
  };

  return { button: { id: 'mic', label: listening ? CANCEL : SAY_IT, tone: 'sun', press }, listening };
}
