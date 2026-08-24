'use client';

/**
 * Pole na prompt — vstup produktu.
 *
 * Do 19. 8. 2026 se v aplikaci nedalo napsat vůbec nic: úvodní stránka byla
 * rotující krychle a světy se daly vyvolat jenom adresou s `promptId` ze
 * zmrazeného korpusu. Tohle je ta chybějící půlka produktu — věta dovnitř, svět
 * ven.
 *
 * **Volá se `/api/generate`, nikdy `/api/emit`.** Není to detail: `/api/emit`
 * bere `promptId` ze zmrazeného korpusu a je to **měřicí** cesta, na které stojí
 * čísla v reportu. Kdyby na ni sahal produkt, měřilo by se něco jiného, než co
 * dělá uživatel. `/api/generate` bere volný text a je pro tohle určená.
 *
 * **Fáze jsou skutečné fáze klienta, ne přehrávaná animace.** `/api/generate` je
 * obyčejný POST bez kanálu událostí — průběh emise po SSE patří měřicí cestě a
 * ta má vlastní obrazovku. Vypisuje se tedy to, co se doopravdy děje tady:
 * odeslání, čekání na odpověď, stavba světa. Nic z toho není odhad času.
 *
 * **Odmítnutí není slepá ulička.** Když generátor na větu zdroj nemá, nabídne
 * se odkaz do záložní větve — ta umí lexikální routování, takže obslouží i text
 * mimo zmrazený korpus. Rozhoduje o tom `promptOutcome.ts`, ne tahle
 * komponenta, a jde o **odkaz, ne o přesměrování**: uživatel musí vidět, že
 * odchází do jiné větve produktu. Odůvodnění obojího je v hlavičce toho modulu.
 *
 * **Plátno po odmítnutí nezůstane prázdné (P11 T20q, rozhodnuto 21. 8. 2026).**
 * Slovo dostane `guaranteeWorld()` z `@/game/guarantee`: rozpozná-li tvar věty,
 * je to odpověď a nic se k ní nedodává; když ne, vydá **náhradní místnost** a
 * důvod, proč z věty svět nevznikl.
 *
 * Náhradní místnost se přitom **nesmí tvářit jako odpověď** — tichá náhrada je
 * horší vada než prázdná scéna, protože se nepozná. Proto se k ní vypíše, že
 * náhrada je, a **nabídka záložní větve zůstává vedle ní**: uživatel dostane
 * obojí, ne jedno místo druhého. Záložní větev totiž pořád může tu větu zahrát
 * líp než jedna univerzální místnost.
 *
 * **Spadlá síť dostane svět taky (P11 T27q, 24. 8. 2026).** Do té doby visela
 * lokální stavba výhradně na větvi `response.status === 404`, takže potřebovala
 * **dosažitelný server** — vytažený kabel, mrtvá Wi-Fi i DevTools „Offline"
 * spadly do `catch` a produkt vypsal hlášku. Záruka „každá věta vydá hratelný
 * svět" tam tím pádem neplatila, přestože ji `evals/hostile-report.json` měří
 * na 70 ze 70. Teď platí: rozhoduje `outcomeForUnreachable()`, které odliší
 * spadlou síť (`TypeError`) od odchodu ze stránky (`AbortError`) — u druhého
 * plátno správně zůstane, na čem bylo.
 *
 * **Větu jde nadiktovat (P11 T23).** Rozhoduje o tom `@/input/speech`, ne tahle
 * komponenta. Dvě věci na tom nejsou samozřejmé:
 *
 * 1. **Tlačítko se v prohlížeči bez rozpoznávání vůbec nevykreslí.** Vypnuté
 *    tlačítko slibuje něco, co nikdy nepůjde — Firefox to rozhraní nemá a nikdy
 *    ho mít nezačne kliknutím.
 * 2. **Dostupnost se čte až po připojení komponenty.** Na serveru `window` není,
 *    takže by první vykreslení tlačítko nemělo a to druhé už ano — a to je přesně
 *    ta neshoda, kterou React 19 při hydrataci hlásí. Proto `useEffect`, ne
 *    počáteční hodnota stavu.
 */

import { useEffect, useRef, useState } from 'react';

import { guaranteeWorld } from '@/game/guarantee';
import { startDictation, supportsDictation, type DictationSession } from '@/input/speech';

import { outcomeFor, outcomeForUnreachable, type PromptOutcome } from './promptOutcome';

/** Fáze, kterými požadavek projde. Pořadí je pořadí výpisu. */
export const PHASES = ['sent', 'generating', 'building'] as const;

export type Phase = (typeof PHASES)[number];

export default function PromptBar({
  onWorld,
  disabled = false,
}: {
  /** Dostane surovou emisi; svět z ní staví volající, ne tahle komponenta. */
  readonly onWorld: (emission: unknown) => void;
  readonly disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase | null>(null);
  const [outcome, setOutcome] = useState<PromptOutcome | null>(null);
  /** Vada, se kterou přišla náhradní místnost. `null`, když žádná nestojí. */
  const [substitute, setSubstitute] = useState<string | null>(null);
  /** Umí prohlížeč diktovat? Čte se až po připojení — viz bod 2 v hlavičce. */
  const [canDictate, setCanDictate] = useState(false);
  const [listening, setListening] = useState(false);
  const dictation = useRef<DictationSession | null>(null);

  useEffect(() => setCanDictate(supportsDictation()), []);

  const busy = phase !== null;

  function toggleDictation(): void {
    if (listening) {
      dictation.current?.stop();
      return;
    }

    setOutcome(null);
    const session = startDictation({
      // Nadiktovaná věta se k napsané **přidá**, nepřepíše ji. Přepsat text,
      // který někdo napsal, je ztráta jeho práce kvůli jednomu kliknutí.
      onText: (spoken) =>
        setText((previous) => (previous.trim() === '' ? spoken : `${previous.trimEnd()} ${spoken}`)),
      onError: (code) =>
        setOutcome({
          message:
            code === 'not-allowed'
              ? 'The microphone is blocked for this page. You can type the sentence.'
              : `Dictation failed (${code}). You can type the sentence.`,
          fallbackHref: null,
        }),
      onEnd: () => {
        dictation.current = null;
        setListening(false);
      },
    });

    // `null` znamená, že se relace nerozeběhla. Stav „poslouchám" by pak zůstal
    // viset napořád, protože konec už nepřijde.
    if (session === null) return;
    dictation.current = session;
    setListening(true);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    // Prázdný vstup není chyba, na kterou se nadává — prostě se nic nestane.
    if (text.trim() === '' || busy || disabled) return;

    setOutcome(null);
    setSubstitute(null);
    setPhase('sent');

    // Požadavek má **vlastní** `try`, a stavba světa je až za ním. Kdyby byly
    // v jednom, `TypeError` z `onWorld()` by se tady vydával za spadlou síť a
    // náhradní místnost by lhala o tom, proč stojí.
    let response: Response;
    let payload: {
      emission?: unknown;
      error?: { code?: string; message?: string };
    };
    try {
      response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text.trim() }),
      });
      setPhase('generating');
      payload = (await response.json()) as typeof payload;
    } catch (thrown) {
      const fallen = outcomeForUnreachable(thrown);
      if (fallen.buildLocally) {
        // Tady se záruka z T20 vyrovnává s větví 404 níž: síť je pryč, ale svět
        // je pořád vidět, protože ho postavil prohlížeč.
        const local = guaranteeWorld(text.trim());
        setPhase('building');
        onWorld(local.emission);
        if (local.kind === 'seed') setSubstitute(local.fault);
      }
      if (fallen.outcome !== null) setOutcome(fallen.outcome);
      setPhase(null);
      return;
    }

    try {
      if (!response.ok || payload.emission === undefined) {
        // Zmrazený korpus na tuhle větu zdroj nemá (`NO_SOURCE` je 404). Slovo
        // dostane záruka světa z T20: běží v prohlížeči, odpoví okamžitě a svět
        // vydá vždycky — buď z rozpoznaného tvaru věty, nebo jako náhradní
        // místnost s pojmenovanou vadou.
        const local = response.status === 404 ? guaranteeWorld(text.trim()) : null;
        if (local !== null) {
          setPhase('building');
          onWorld(local.emission);
          // Rozpoznaný tvar JE odpověď na větu — nic se k němu nedodává.
          if (local.kind === 'shape') return;
          // Náhradní místnost odpověď NENÍ, a propadá proto dolů k hlášce
          // i k nabídce záložní větve.
          setSubstitute(local.fault);
        }
        setOutcome(
          outcomeFor(
            response.status,
            payload.error?.code ?? 'UNKNOWN',
            payload.error?.message ?? '',
            text,
          ),
        );
        setPhase(null);
        return;
      }

      setPhase('building');
      onWorld(payload.emission);
    } finally {
      setPhase(null);
    }
  }

  return (
    <form onSubmit={submit} data-testid="prompt-form" style={FORM}>
      <textarea
        data-testid="prompt-input"
        aria-label="Describe the world you want"
        placeholder="Describe the world you want — for example: a puzzle room where I have to find three keys to open the exit door"
        value={text}
        rows={2}
        onChange={(event) => setText(event.target.value)}
        style={INPUT}
      />
      {!canDictate ? null : (
        // `type="button"` je nutnost, ne zvyk: tlačítko bez typu ve formuláři
        // odesílá, takže by kliknutí na mikrofon poslalo rozepsanou větu pryč.
        <button
          type="button"
          data-testid="prompt-dictate"
          aria-pressed={listening}
          disabled={busy || disabled}
          onClick={toggleDictation}
          style={listening ? { ...DICTATE, ...DICTATE_ON } : DICTATE}
        >
          {listening ? 'Listening…' : 'Dictate'}
        </button>
      )}

      <button type="submit" data-testid="prompt-submit" disabled={busy || disabled} style={BUTTON}>
        {busy ? 'Working…' : 'Build the world'}
      </button>

      {phase === null ? null : (
        <ol data-testid="prompt-progress" style={PROGRESS}>
          {PHASES.map((step) => (
            <li
              key={step}
              data-testid={`prompt-phase-${step.replace(/\s/g, '-')}`}
              style={{ opacity: PHASES.indexOf(step) <= PHASES.indexOf(phase) ? 1 : 0.35 }}
            >
              {step}
            </li>
          ))}
        </ol>
      )}

      {substitute === null ? null : (
        <p data-testid="prompt-substitute" style={SUBSTITUTE}>
          I could not read this sentence, so what stands on the canvas is a{' '}
          <strong>substitute room</strong>. It is playable, but it is not the world from your
          sentence{' '}
          <span data-testid="prompt-substitute-fault" style={FAULT}>
            ({substitute})
          </span>
        </p>
      )}

      {outcome === null ? null : (
        <p data-testid="prompt-error" role="alert" style={ERROR}>
          {outcome.message}
          {outcome.fallbackHref === null ? null : (
            <>
              {' '}
              <a data-testid="prompt-fallback-link" href={outcome.fallbackHref} style={FALLBACK}>
                Play it in the fallback branch
              </a>
            </>
          )}
        </p>
      )}
    </form>
  );
}

const FORM: React.CSSProperties = {
  position: 'absolute',
  top: '1rem',
  left: '50%',
  transform: 'translateX(-50%)',
  // O patro výš než panely v rozích. Ty si horní pruh nechávají volný
  // (`CORNER_BASE` v `src/app/page.tsx`), ale hláška může být delší, než s čím
  // ten pruh počítá — a vstup s odkazem na záložní větev musí být klikatelný
  // vždycky, ne jen když se text vejde.
  zIndex: 3,
  display: 'flex',
  gap: '0.6rem',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  width: 'min(46rem, calc(100vw - 2rem))',
  padding: '0.75rem',
  borderRadius: '0.6rem',
  background: 'rgba(12, 22, 26, 0.82)',
  border: '1px solid #24383d',
};

const INPUT: React.CSSProperties = {
  flex: '1 1 24rem',
  resize: 'vertical',
  padding: '0.5rem 0.6rem',
  borderRadius: '0.4rem',
  border: '1px solid #2f4a50',
  background: '#0c1418',
  color: '#dceaec',
  font: 'inherit',
};

const BUTTON: React.CSSProperties = {
  padding: '0.55rem 1rem',
  borderRadius: '0.4rem',
  border: '1px solid #2f9e8f',
  background: '#2f9e8f',
  color: '#06181a',
  font: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
};

/** Diktování je druhá cesta ke stejné věci, ne hlavní akce — proto obrys, ne plocha. */
const DICTATE: React.CSSProperties = {
  padding: '0.55rem 0.9rem',
  borderRadius: '0.4rem',
  border: '1px solid #2f4a50',
  background: 'transparent',
  color: '#9fc0c2',
  font: 'inherit',
  cursor: 'pointer',
};

const DICTATE_ON: React.CSSProperties = {
  borderColor: '#e8a33d',
  color: '#e8a33d',
};

const PROGRESS: React.CSSProperties = {
  flexBasis: '100%',
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  gap: '0.75rem',
  color: '#9fc0c2',
  fontSize: '0.85rem',
};

const FALLBACK: React.CSSProperties = {
  color: '#2f9e8f',
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

const ERROR: React.CSSProperties = {
  flexBasis: '100%',
  margin: 0,
  color: '#e8a33d',
  fontSize: '0.9rem',
};

const SUBSTITUTE: React.CSSProperties = {
  flexBasis: '100%',
  margin: 0,
  color: '#9fc0c2',
  fontSize: '0.9rem',
};

/** Kód vady je pro čtenáře, který ho chce vidět — ne hlavní sdělení. */
const FAULT: React.CSSProperties = {
  color: '#6d8b8e',
  fontFamily: 'ui-monospace, monospace',
  fontSize: '0.82rem',
};
