'use client';

/**
 * Diktování věty na `/play` (P29D T6) – ikona mikrofonu u pole.
 *
 * Logika je `@/input/speech` (P11 T23, vlastní test v Node): rozhraní
 * prohlížeče, anglický přepis, nic se nestahuje a zvuk nikam neposíláme.
 * Prohlížeč bez Web Speech tlačítko **nevidí vůbec** – offline přepis
 * (Moonshine) neprošel licenční bránou, důvod je v `docs/play/shell.md`.
 *
 * Přepis se k napsanému textu přidá, nepřepíše ho. Stisk nesmí do hry:
 * klávesy i ťuky hry poslouchají nativně, proto nativní `stopPropagation`
 * (stejně jako `ShareButton`).
 */

import { useEffect, useRef, useState } from 'react';

import { type DictationSession, startDictation, supportsDictation } from '@/input/speech';

import { Icon } from './ui';

/** Nadiktované k napsanému: mezera mezi, prázdné pole = jen přepis. */
export const appendSpoken = (previous: string, spoken: string): string => (previous.trim() === '' ? spoken : `${previous.trimEnd()} ${spoken}`);

/** Výchozí vzhled je ikona v okraji pole; domov (P34 T3) dává slunečné kolo kitu v řadě akcí bubliny. */
const IN_FIELD = 'play-button play-button-quiet play-mic';

export function MicButton({
  onText,
  disabled = false,
  testId = 'play-mic',
  className = IN_FIELD,
}: {
  readonly onText: (spoken: string) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
  readonly className?: string;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  const session = useRef<DictationSession | null>(null);
  // Dostupnost až po připojení: server tlačítko neposílá, hydratace nic nevrací.
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => setAvailable(supportsDictation()), []);
  useEffect(() => () => session.current?.stop(), []);
  useEffect(() => {
    const element = button.current;
    if (element === null) return;
    const stop = (event: Event) => event.stopPropagation();
    const events = ['pointerdown', 'pointerup', 'keydown', 'keyup'] as const;
    for (const name of events) element.addEventListener(name, stop);
    return () => {
      for (const name of events) element.removeEventListener(name, stop);
    };
  }, [available]);

  if (!available) return null;

  function toggle(): void {
    if (listening) {
      session.current?.stop();
      return;
    }
    setFailure(null);
    const started = startDictation({
      onText,
      onError: (code) => setFailure(code === 'not-allowed' ? 'The microphone is blocked for this page. You can type instead.' : 'Dictation failed. You can type instead.'),
      onEnd: () => {
        session.current = null;
        setListening(false);
      },
    });
    if (started === null) return;
    session.current = started;
    setListening(true);
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        data-testid={testId}
        data-listening={listening ? 'true' : 'false'}
        aria-pressed={listening}
        aria-label={listening ? 'Stop dictation' : 'Dictate with the microphone'}
        disabled={disabled}
        onClick={toggle}
      >
        <Icon name="mic" />
        {/* Ikona v poli (P33 T4); text zůstává pro hledání podle textu a pro stav poslechu. */}
        <span className="play-sr-only">{listening ? 'Listening…' : 'Mic'}</span>
      </button>
      {failure !== null && (
        <span className="play-alert" role="alert">
          {failure}
        </span>
      )}
    </>
  );
}
