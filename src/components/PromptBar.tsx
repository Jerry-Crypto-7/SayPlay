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
 */

import { useState } from 'react';

import { guaranteeWorld } from '@/game/guarantee';

import { outcomeFor, type PromptOutcome } from './promptOutcome';

/** Fáze, kterými požadavek projde. Pořadí je pořadí výpisu. */
export const PHASES = ['odesláno', 'generuje se', 'staví se'] as const;

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

  const busy = phase !== null;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    // Prázdný vstup není chyba, na kterou se nadává — prostě se nic nestane.
    if (text.trim() === '' || busy || disabled) return;

    setOutcome(null);
    setSubstitute(null);
    setPhase('odesláno');

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text.trim() }),
      });
      setPhase('generuje se');

      const payload = (await response.json()) as {
        emission?: unknown;
        error?: { code?: string; message?: string };
      };

      if (!response.ok || payload.emission === undefined) {
        // Zmrazený korpus na tuhle větu zdroj nemá (`NO_SOURCE` je 404). Slovo
        // dostane záruka světa z T20: běží v prohlížeči, odpoví okamžitě a svět
        // vydá vždycky — buď z rozpoznaného tvaru věty, nebo jako náhradní
        // místnost s pojmenovanou vadou.
        const local = response.status === 404 ? guaranteeWorld(text.trim()) : null;
        if (local !== null) {
          setPhase('staví se');
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

      setPhase('staví se');
      onWorld(payload.emission);
    } catch {
      // Síť spadla nebo uživatel odešel ze stránky. Obojí je stav k vypsání,
      // ne výjimka k propadnutí — plátno má zůstat, na čem bylo.
      setOutcome({ message: 'Požadavek se nepodařilo odeslat.', fallbackHref: null });
    } finally {
      setPhase(null);
    }
  }

  return (
    <form onSubmit={submit} data-testid="prompt-form" style={FORM}>
      <textarea
        data-testid="prompt-input"
        aria-label="Popiš svět, který chceš"
        placeholder="Popiš svět, který chceš — třeba: a puzzle room where I have to find three keys to open the exit door"
        value={text}
        rows={2}
        onChange={(event) => setText(event.target.value)}
        style={INPUT}
      />
      <button type="submit" data-testid="prompt-submit" disabled={busy || disabled} style={BUTTON}>
        {busy ? 'Pracuju…' : 'Postav svět'}
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
          Tuhle větu jsem nepřečetl, takže na plátně stojí <strong>náhradní místnost</strong>. Hrát v ní
          jde, ale svět z tvé věty to není{' '}
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
                Zahrát v záložní větvi
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
