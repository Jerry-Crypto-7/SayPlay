'use client';

/**
 * Náhled vítězné cesty — **důkaz, ne tvrzení** (P11 T15).
 *
 * Systém nepřijme svět, o kterém neumí ukázat, že se dá dohrát: certifikát je
 * podmíněný svědkem, kterého ověřovač krok po kroku přehrál. Tenhle pruh tu
 * stopu předvede — zrychleně, tah po tahu — takže „svět je dohratelný" přestává
 * být větou v hlavičce a stává se něčím, na co se dá koukat.
 *
 * ## Hash je to, co z náhledu dělá důkaz
 *
 * Kdyby panel pouštěl libovolnou stopu a psal u ní „takhle to systém vyhrál",
 * byla by to dekorace, kterou nikdo nemůže zkontrolovat. `window.__pipeline`
 * proto vydává obojí — stopu, kterou náhled přehrává, i certifikát s hashem
 * stopy, kterou ověřovač **doopravdy odkrokoval** (`hashWitness` v
 * `src/verify/witness.ts`). Když se ty dva hashe rozejdou, náhled lže a test to
 * pozná.
 *
 * ## Rychlost je wall-clock, obsah není
 *
 * Kadence přehrávání běží na `setInterval`, protože je to animace — patří do
 * téže skupiny jako kamera nebo částice a do hashovaného stavu nevstupuje.
 * Obsah, tedy sama stopa a tiky v ní, je zmrazený certifikátem a nezávisí na
 * tom, jak rychle se překresluje.
 */

import { useEffect, useMemo, useState } from 'react';

// `describeStep` sdílí náhled s větou pro model (vlna 2 T2). Dvě kopie téhož
// popisu tahu by se rozešly a porotce by četl jiný text, než dostane model.
import { describeStep } from '@/model/local/rejection-prompt';
import type { TraceInput, WorldDocRuntime } from '@/sim/interpreter';
import { hashWitness, verifyWitness, type Certificate } from '@/verify/witness';

declare global {
  interface Window {
    __pipeline?: {
      /**
       * Stopa, kterou náhled přehrává. Prázdná u světa, který certifikát nemá —
       * u nedohratelného světa žádná vítězná cesta neexistuje a vrátit nějakou
       * by znamenalo si ji vymyslet.
       */
      witness: () => readonly TraceInput[];
      /** Certifikát, kterým ověřovač svět potvrdil. `null` u necertifikovaného. */
      certificate: () => Certificate | null;
      /** Táž hashovací funkce, jakou počítá ověřovač. Ne její kopie. */
      hashWitness: (witness: readonly TraceInput[]) => string;
    };
  }
}

/** Jeden tah za tuhle dobu. Pět tahů tedy proběhne pod dvě sekundy. */
const STEP_MS = 380;

export default function WitnessPreview({ world }: { readonly world: WorldDocRuntime | null }) {
  const certified = useMemo(() => {
    if (world === null) return null;
    const result = verifyWitness(world, world.trace);
    return result.verdict === 'CERTIFIED' ? result : null;
  }, [world]);

  const trace = certified === null ? [] : (world?.trace ?? []);

  // `-1` = ještě se nezačalo. Index se drží zvlášť od stopy, aby se náhled dal
  // pustit znovu bez přestavění světa.
  const [step, setStep] = useState(-1);
  const [run, setRun] = useState(0);

  useEffect(() => {
    setStep(-1);
  }, [world, run]);

  useEffect(() => {
    if (trace.length === 0 || step >= trace.length - 1) return undefined;
    const timer = setTimeout(() => setStep((was) => was + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [trace.length, step]);

  useEffect(() => {
    window.__pipeline = {
      witness: () => trace,
      certificate: () => certified,
      hashWitness,
    };
  }, [trace, certified]);

  if (world === null) return null;

  if (certified === null)
    return (
      <section data-testid="witness-preview" data-certified="false" style={STRIP}>
        <span data-testid="witness-uncertified" style={MUTED}>
          This world carries no winning path — the verifier did not certify it.
        </span>
      </section>
    );

  // Při výměně světa se nová stopa vyrenderuje dřív, než efekt výš stihne
  // resetovat index starého náhledu. Stará stopa může být delší; její poslední
  // index pak v nové stopě neexistuje. Přechodový render proto bere index mimo
  // rozsah stejně jako stav před startem a nikdy z něj nečte tah.
  const activeStep = step >= 0 && step < trace.length ? step : -1;
  const done = trace.length === 0 || activeStep >= trace.length - 1;
  const current = activeStep < 0 ? null : trace[activeStep]!;
  const shown = activeStep + 1;
  const progress = trace.length === 0 ? 0 : (shown / trace.length) * 100;

  return (
    <section data-testid="witness-preview" data-certified="true" data-done={done ? 'true' : 'false'} style={STRIP}>
      <div style={HEAD}>
        <strong>How the system won</strong>
        <span data-testid="witness-count" style={MUTED}>
          {String(shown)} / {String(trace.length)} · win at tick {String(certified.witnessLength)}
        </span>
      </div>

      <div style={TRACK} aria-hidden="true">
        <div style={{ ...FILL, width: `${String(progress)}%` }} />
      </div>

      <p data-testid="witness-step" style={STEP_TEXT}>
        {current === null
          ? 'Replaying the trace it found…'
          : `${String(activeStep + 1)}. tick ${String(current.tick)} — ${describeStep(current)}`}
      </p>

      {done ? (
        <button type="button" data-testid="witness-replay" onClick={() => setRun((was) => was + 1)} style={REPLAY}>
          Replay
        </button>
      ) : null}
    </section>
  );
}

const STRIP: React.CSSProperties = {
  // Ukotvení nese pravý sloupec v `src/app/page.tsx`. Sám by si nárokoval roh,
  // což bylo 21. 8. 2026 naměřeno jako vada — ukazatel stahování modelu tehdy
  // stál na tomtéž místě.
  pointerEvents: 'auto',
  width: 'min(20rem, calc(100vw - 2rem))',
  padding: '0.6rem 0.75rem',
  borderRadius: '0.6rem',
  background: 'rgba(12, 22, 26, 0.9)',
  border: '1px solid #24383d',
  color: '#dceaec',
  fontSize: '0.82rem',
};

const HEAD: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: '0.5rem',
};

const MUTED: React.CSSProperties = {
  color: '#9fc0c2',
  fontSize: '0.76rem',
};

const TRACK: React.CSSProperties = {
  height: '0.25rem',
  margin: '0.45rem 0',
  borderRadius: '0.2rem',
  background: '#1b2c30',
  overflow: 'hidden',
};

const FILL: React.CSSProperties = {
  height: '100%',
  background: '#2f9e8f',
  transition: 'width 280ms linear',
};

const STEP_TEXT: React.CSSProperties = {
  margin: 0,
  fontVariantNumeric: 'tabular-nums',
};

const REPLAY: React.CSSProperties = {
  marginTop: '0.45rem',
  padding: '0.3rem 0.6rem',
  borderRadius: '0.35rem',
  border: '1px solid #2f9e8f',
  background: 'transparent',
  color: '#5fd3bd',
  font: 'inherit',
  fontSize: '0.78rem',
  cursor: 'pointer',
};
