'use client';

/**
 * Domov `/play` podle kitu Sayplay (P34 T3, `01-home@2x.png`): bublina
 * `.sp-prompt` s viditelným popiskem, `Surprise me`, počítadlem a mikrofonem,
 * pod ní „Make it!“ a karty nápadů. Věta → `POST /api/play/games` →
 * `router.push('/play/<id>')`. Enter odešle, Shift+Enter zalomí řádek.
 *
 * Karta nápadu i `Surprise me` větu jen vloží do pole – hru spustí až „Make
 * it!“ (kit: klepnutí nespouští stavbu). Po odeslání překryje stránku
 * `BuildingScreen` s větou a čtyřmi kroky `BUILD_STEPS`: první dva patří
 * `/play`, zbylé dva `/play/[id]`. Chyba dveří je chybový toast kitu
 * (`.sp-toast--error`, P34 T4) s `Try again` a věta v poli zůstane; bez sítě
 * odejde věta sama, jakmile se síť vrátí. Na telefonu pod tím plave `TabBar`:
 * Make k poli, Play k feedu.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';

import { moodTone } from './Feed';
import { FirstVisitHint, isFirstVisit, markVisited } from './FirstVisitHint';
import { appendSpoken, MicButton } from './MicButton';
import { BUILD_FAILED, COUNTER_WARN, IDEAS, NOT_SENT, OFFLINE, PLACEHOLDER, PROMPT_LABEL, SENTENCE_LIMIT, STARTERS, TOO_VAGUE } from './starters';
import { BuildingScreen, Button, Icon, TabBar } from './ui';

type Phase = { readonly kind: 'idle' } | { readonly kind: 'busy'; readonly step: 0 | 1 } | { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'offline' };

/** Barvy karet nápadů v pořadí kitu a střídavý náklon (šachovnice 2×2 jako v referenci). */
const IDEA_LOOKS = ['sp-idea--mint sp-tilt-l', 'sp-idea--sun sp-tilt-r', 'sp-idea--sky sp-tilt-r', 'sp-idea--gum sp-tilt-l'] as const;

/**
 * Co hráč uslyší, když dveře hru nepostaví. 422 (věta nešla na hratelnou hru)
 * je „Build failed“ z kitu – technický důvod serveru hráči nic neřekne; ostatní
 * (kvóta, vypnutí, úložiště) nesou vlastní větu, jen s velkým písmenem na začátku.
 */
function doorMessage(status: number, code: unknown, message: unknown): string {
  if (typeof message !== 'string' || message === '') return BUILD_FAILED;
  // Zakázané téma ve větě (P40 T1) i v návrhu z ní (T2): dveře posílají větu kitu „Blocked content“ – „Try fewer rules“ by hráče poslal zkoušet totéž znovu.
  if (code === 'SENTENCE_REJECTED' || code === 'CONTENT_REJECTED') return message;
  if (status === 422) return BUILD_FAILED;
  return message[0]!.toUpperCase() + message.slice(1);
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
  // Nápověda první návštěvy (P44D T12) je už v HTML ze serveru, aby pole pod ní neposkočilo (T18). Vracejícímu
  // se hráči ji do hydratace schová `HIDE_FOR_RETURNING` a pak ji odebere layout efekt, ještě před dalším snímkem.
  const [firstVisit, setFirstVisit] = useState(true);
  useLayoutEffect(() => {
    if (!isFirstVisit()) setFirstVisit(false);
  }, []);

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
    let response: Response;
    try {
      response = await fetch('/api/play/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sentence: text }),
      });
    } catch {
      setPhase(navigator.onLine ? { kind: 'failed', message: NOT_SENT } : { kind: 'offline' });
      return;
    }
    // Tělo, které není JSON (výpadek za proxy), je selhání stavby jako každé jiné.
    const body = (await response.json().catch(() => ({}))) as { url?: unknown; error?: { code?: unknown; message?: unknown } };
    if (!response.ok || typeof body.url !== 'string') {
      setPhase({ kind: 'failed', message: doorMessage(response.status, body.error?.code, body.error?.message) });
      return;
    }
    setPhase({ kind: 'busy', step: 1 });
    markVisited();
    router.push(body.url);
  }

  // Bez sítě (kit, Offline): věta zůstane v poli a odejde sama, jakmile se síť vrátí.
  const offline = phase.kind === 'offline';
  useEffect(() => {
    if (!offline) return;
    const back = (): void => void create(trimmed);
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
    // `create` je nová každým renderem; znovu se přihlásit stačí při změně věty.
  }, [offline, trimmed]);

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
      {firstVisit && (
        <FirstVisitHint
          disabled={busy}
          onPick={fill}
          onTryOwn={() => fill(sentence)}
          onClose={() => {
            markVisited();
            setFirstVisit(false);
          }}
        />
      )}
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
        {/* Od odeslání do první scény celá obrazovka (T14): věta v tónu nálady a kroky stavby. */}
        {phase.kind === 'busy' && <BuildingScreen title={trimmed} tone={moodTone(trimmed)} step={phase.step} />}
        {/* Chybový toast kitu zůstane, dokud hráč znovu neodešle (kit: chyby nemizí samy). */}
        {(phase.kind === 'failed' || phase.kind === 'offline') && (
          <div className="sp-toast sp-toast--error play-create-error" data-testid="play-create-error" role="alert">
            <Icon name="alert" />
            <span>{phase.kind === 'offline' ? OFFLINE : phase.message}</span>
            {phase.kind === 'failed' && (
              <Button variant="secondary" size="s" disabled={trimmed.length === 0 || over} onClick={() => void create(trimmed)}>
                Try again
              </Button>
            )}
          </div>
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
