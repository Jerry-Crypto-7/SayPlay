'use client';

/**
 * Formulář `/play`: věta → `POST /api/play/games` → `router.push('/play/<id>')`.
 * Karta vzoru pošle svou větu rovnou (P28D T7).
 *
 * Po odeslání překryje stránku načítací obrazovka (`BuildingScreen`, P33 T14)
 * se všemi čtyřmi kroky `BUILD_STEPS` (T9): první dva patří `/play`
 * (odeslání, odpověď 201), zbylé dva `/play/[id]`, kde se svět načítá a staví
 * – tady čekají. Chyba dveří se ukáže větou z `error.message` s tlačítkem
 * `Try again` a věta v poli zůstane – člověk ji opraví, ne napíše znovu. Z
 * feedu k poli posune plovoucí `+ New game`, dokud pole není vidět.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { ArchetypeId } from '@/play/registry';

import { moodTone } from './Feed';
import { appendSpoken, MicButton } from './MicButton';
import { BUILD_STEPS, PLACEHOLDER, SENTENCE_LIMIT, STARTERS } from './starters';
import { BuildingScreen, Button, Icon, type IconName } from './ui';

type Phase = { readonly kind: 'idle' } | { readonly kind: 'busy'; readonly step: 0 | 1 } | { readonly kind: 'failed'; readonly message: string };

/** Počítadlo znaků se ukáže až u stropu – do té doby jen ruší. */
const COUNTER_FROM = 400;

/** Ikona druhu hry na kartě vzoru. */
const STARTER_ICONS: Partial<Record<ArchetypeId, IconName>> = {
  chase_escape: 'run',
  collect_exit: 'collect',
  survival_timer: 'timer',
  checkpoint_race: 'flag',
  delivery: 'box',
  switch_puzzle: 'toggle',
  hazard_crossing: 'jump',
  combat_lite: 'target',
};

/** Průběh stavby: všechny čtyři kroky, hotové odškrtnuté, aktivní zvýrazněný. */
export function BuildSteps({ active }: { readonly active: number }) {
  return (
    <ol className="play-steps" data-testid="play-status" aria-live="polite">
      {BUILD_STEPS.map((step, index) => (
        <li key={step} data-state={index < active ? 'done' : index === active ? 'active' : 'todo'} aria-current={index === active ? 'step' : undefined}>
          {step}
        </li>
      ))}
    </ol>
  );
}

export function CreateGame() {
  const router = useRouter();
  const form = useRef<HTMLFormElement | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const [sentence, setSentence] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [formSeen, setFormSeen] = useState(false);

  const trimmed = sentence.trim();
  const over = sentence.length > SENTENCE_LIMIT;
  const busy = phase.kind === 'busy';

  // Plovoucí `+ New game` jen tehdy, když pole není na obrazovce.
  useEffect(() => {
    const element = form.current;
    if (element === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setFormSeen(entry?.isIntersecting ?? false));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  async function create(text: string): Promise<void> {
    if (text.length === 0 || text.length > SENTENCE_LIMIT || busy) return;
    setPhase({ kind: 'busy', step: 0 });
    try {
      const response = await fetch('/api/play/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sentence: text }),
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
      <form
        ref={form}
        className="play-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void create(trimmed);
        }}
      >
        <div className="play-field">
          <textarea
            ref={field}
            className="play-sentence"
            data-testid="play-sentence"
            aria-label="Describe your game"
            placeholder={PLACEHOLDER}
            value={sentence}
            maxLength={SENTENCE_LIMIT}
            disabled={busy}
            onChange={(event) => setSentence(event.target.value)}
          />
          <MicButton disabled={busy} onText={(spoken) => setSentence((previous) => appendSpoken(previous, spoken).slice(0, SENTENCE_LIMIT))} />
        </div>
        <div className="play-form-row">
          {sentence.length >= COUNTER_FROM && (
            <span className="play-counter" data-over={over ? 'true' : 'false'} aria-live="polite">
              {sentence.length} / {SENTENCE_LIMIT}
            </span>
          )}
          <Button variant="accent" size="l" type="submit" data-testid="play-create" disabled={busy || trimmed.length === 0 || over}>
            Play it
          </Button>
        </div>
        {/* Od odeslání do první scény celá obrazovka (T14): název z věty, tón nálady, kroky stavby. */}
        {phase.kind === 'busy' && (
          <BuildingScreen title={trimmed} tone={moodTone(trimmed)}>
            <BuildSteps active={phase.step} />
          </BuildingScreen>
        )}
        {phase.kind === 'failed' && (
          <p className="play-alert" role="alert">
            <span>{phase.message}</span>
            <Button variant="quiet" disabled={trimmed.length === 0 || over} onClick={() => void create(trimmed)}>
              Try again
            </Button>
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
                // P28D T7: vzor rovnou hraje; věta zůstane v poli, kdyby stavba selhala.
                setSentence(starter.sentence);
                void create(starter.sentence);
              }}
            >
              <Icon name={STARTER_ICONS[starter.archetype] ?? 'play'} />
              <span className="play-starter-sentence">{starter.sentence}</span>
            </button>
          </li>
        ))}
      </ul>

      <Button
        className="play-new-game"
        data-testid="play-new-game"
        data-hidden={formSeen ? 'true' : 'false'}
        onClick={() => {
          form.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          field.current?.focus({ preventScroll: true });
        }}
      >
        <Icon name="plus" />
        New game
      </Button>
    </>
  );
}
