'use client';

/**
 * Domov `/play` podle kitu Sayplay (P34 T3, `01-home@2x.png`): bublina
 * `.sp-prompt` s viditelným popiskem, `Surprise me`, počítadlem a mikrofonem,
 * pod ní „Make it!“ a karty nápadů. Věta → `POST /api/play/games` →
 * `router.push('/play/<id>')`. Enter odešle, Shift+Enter zalomí řádek.
 *
 * Karta nápadu i `Surprise me` větu jen vloží do pole – hru spustí až „Make
 * it!“ (kit: klepnutí nespouští stavbu). Po odeslání překryje stránku
 * `BuildingScreen` se čtyřmi kroky `BUILD_STEPS`: první dva patří `/play`,
 * zbylé dva `/play/[id]`. Chyba dveří se ukáže větou z `error.message`
 * s `Try again` a věta v poli zůstane. Na telefonu pod tím plave `TabBar`:
 * Make k poli, Play k feedu.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { moodTone } from './Feed';
import { appendSpoken, MicButton } from './MicButton';
import { BUILD_STEPS, COUNTER_WARN, IDEAS, PLACEHOLDER, PROMPT_LABEL, SENTENCE_LIMIT, STARTERS, TOO_VAGUE } from './starters';
import { BuildingScreen, Button, Icon, TabBar } from './ui';

type Phase = { readonly kind: 'idle' } | { readonly kind: 'busy'; readonly step: 0 | 1 } | { readonly kind: 'failed'; readonly message: string };

/** Barvy karet nápadů v pořadí kitu a střídavý náklon (šachovnice 2×2 jako v referenci). */
const IDEA_LOOKS = ['sp-idea--mint sp-tilt-l', 'sp-idea--sun sp-tilt-r', 'sp-idea--sky sp-tilt-r', 'sp-idea--gum sp-tilt-l'] as const;

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
  const [formSeen, setFormSeen] = useState(true);
  // „Make it!“ je aktivní i nad prázdným polem (reference kitu); prázdné odeslání řekne, co napsat.
  const [vague, setVague] = useState(false);

  const trimmed = sentence.trim();
  const over = sentence.length > SENTENCE_LIMIT;
  const busy = phase.kind === 'busy';

  // Lišta: Make je aktivní, dokud je pole na obrazovce, jinak Play (feed).
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

  /** Věta do pole bez startu (karta nápadu, `Surprise me`); pole se ukáže a dostane kurzor. */
  function fill(text: string): void {
    setSentence(text);
    form.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    field.current?.focus({ preventScroll: true });
  }

  function surprise(): void {
    const others = STARTERS.filter((starter) => starter.sentence !== sentence);
    fill(others[Math.floor(Math.random() * others.length)]!.sentence);
  }

  return (
    <>
      <form
        ref={form}
        className="play-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (trimmed.length === 0) {
            setVague(true);
            field.current?.focus();
            return;
          }
          void create(trimmed);
        }}
      >
        <div className={vague ? 'sp-prompt play-prompt is-error' : 'sp-prompt play-prompt'}>
          <label className="sp-prompt__label" htmlFor="play-sentence">
            {PROMPT_LABEL}
          </label>
          <textarea
            id="play-sentence"
            ref={field}
            className="sp-prompt__field play-sentence"
            data-testid="play-sentence"
            placeholder={PLACEHOLDER}
            value={sentence}
            maxLength={SENTENCE_LIMIT}
            disabled={busy}
            onChange={(event) => {
              setSentence(event.target.value);
              setVague(false);
            }}
            onKeyDown={(event) => {
              // Enter odešle (kit 05-layout), Shift+Enter a skládání znaků IME zůstanou psaním.
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              form.current?.requestSubmit();
            }}
          />
          <div className="sp-prompt__actions">
            <Button variant="secondary" size="s" data-testid="play-surprise" disabled={busy} onClick={surprise}>
              <Icon name="dice" />
              Surprise me
            </Button>
            <span className="sp-prompt__count" data-testid="play-counter" data-warn={sentence.length >= COUNTER_WARN ? 'true' : 'false'} aria-live="polite">
              {sentence.length}/{SENTENCE_LIMIT}
            </span>
            <MicButton
              className="sp-btn sp-btn--icon sp-btn--sun play-mic"
              disabled={busy}
              onText={(spoken) => setSentence((previous) => appendSpoken(previous, spoken).slice(0, SENTENCE_LIMIT))}
            />
          </div>
        </div>
        {vague && (
          <p className="sp-field-error" data-testid="play-vague" role="alert">
            <Icon name="alert" />
            {TOO_VAGUE}
          </p>
        )}
        <Button size="l" type="submit" className="sp-btn--block" data-testid="play-create" disabled={busy || over}>
          Make it!
        </Button>
        {/* Od odeslání do první scény celá obrazovka (T14): název z věty, tón nálady, kroky stavby. */}
        {phase.kind === 'busy' && (
          <BuildingScreen title={trimmed} tone={moodTone(trimmed)}>
            <BuildSteps active={phase.step} />
          </BuildingScreen>
        )}
        {phase.kind === 'failed' && (
          <p className="play-alert" role="alert">
            <span>{phase.message}</span>
            <Button variant="secondary" disabled={trimmed.length === 0 || over} onClick={() => void create(trimmed)}>
              Try again
            </Button>
          </p>
        )}
      </form>

      <section className="play-ideas" aria-labelledby="play-ideas-title">
        <h2 id="play-ideas-title" className="sp-title-m">
          Need an idea? Grab one.
        </h2>
        <ul className="play-idea-grid">
          {IDEAS.map((idea, index) => (
            <li key={idea.archetype}>
              <button type="button" className={`sp-idea ${IDEA_LOOKS[index % IDEA_LOOKS.length]}`} data-testid={`play-starter-${idea.archetype}`} disabled={busy} onClick={() => fill(idea.sentence)}>
                {idea.sentence}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <TabBar
        active={formSeen ? 'make' : 'play'}
        onMake={() => fill(sentence)}
        onPlay={() => document.querySelector('.play-pager')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
      />
    </>
  );
}
