'use client';

/**
 * Formulář `/play`: věta → `POST /api/play/games` → `router.push('/play/<id>')`.
 *
 * Stavový řádek ukazuje první dva kroky z `BUILD_STEPS` (odeslání, odpověď 201);
 * zbylé dva patří `/play/[id]`, kde se svět načítá a staví. Chyba dveří se
 * ukáže větou z `error.message` a věta v poli zůstane – člověk ji opraví, ne
 * napíše znovu.
 */

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { BUILD_STEPS, PLACEHOLDER, SENTENCE_LIMIT, STARTERS } from './starters';

type Phase = { readonly kind: 'idle' } | { readonly kind: 'busy'; readonly step: 0 | 1 } | { readonly kind: 'failed'; readonly message: string };

export function CreateGame() {
  const router = useRouter();
  const [sentence, setSentence] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const trimmed = sentence.trim();
  const over = sentence.length > SENTENCE_LIMIT;
  const busy = phase.kind === 'busy';

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (trimmed.length === 0 || over || busy) return;
    setPhase({ kind: 'busy', step: 0 });
    try {
      const response = await fetch('/api/play/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sentence: trimmed }),
      });
      const body = (await response.json()) as { url?: string; error?: { message?: string } };
      if (!response.ok || typeof body.url !== 'string') {
        setPhase({ kind: 'failed', message: body.error?.message ?? 'This sentence could not become a game.' });
        return;
      }
      setPhase({ kind: 'busy', step: 1 });
      router.push(body.url);
    } catch {
      setPhase({ kind: 'failed', message: 'The game could not be created. Check your connection and try again.' });
    }
  }

  return (
    <>
      <form className="play-form" onSubmit={submit}>
        <textarea
          className="play-sentence"
          data-testid="play-sentence"
          aria-label="Describe your game"
          placeholder={PLACEHOLDER}
          value={sentence}
          maxLength={SENTENCE_LIMIT}
          disabled={busy}
          onChange={(event) => setSentence(event.target.value)}
        />
        <div className="play-form-row">
          <span className="play-counter" data-over={over ? 'true' : 'false'} aria-live="polite">
            {sentence.length} / {SENTENCE_LIMIT}
          </span>
          <button className="play-button" type="submit" data-testid="play-create" disabled={busy || trimmed.length === 0 || over}>
            Play it
          </button>
        </div>
        {phase.kind === 'busy' && (
          <p className="play-status" data-testid="play-status" aria-live="polite">
            {BUILD_STEPS[phase.step]}…
          </p>
        )}
        {phase.kind === 'failed' && (
          <p className="play-alert" role="alert">
            {phase.message}
          </p>
        )}
      </form>

      <p className="play-starters-title">Or start from one of these</p>
      <ul className="play-starters">
        {STARTERS.map((starter) => (
          <li key={starter.archetype}>
            <button
              type="button"
              className="play-starter"
              data-testid={`play-starter-${starter.archetype}`}
              disabled={busy}
              onClick={() => {
                setSentence(starter.sentence);
                setPhase({ kind: 'idle' });
              }}
            >
              <span className="play-starter-label">{starter.label}</span>
              <span className="play-starter-sentence">{starter.sentence}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
