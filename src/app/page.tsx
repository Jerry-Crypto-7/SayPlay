'use client';

/**
 * Úvodní stránka — věta dovnitř, svět ven.
 *
 * Prompt a plátno drží jedna komponenta, protože mezi nimi teče přesně jedna
 * hodnota: emise. `PromptBar` ji přinese z `/api/generate`, tady se z ní postaví
 * běh a `Stage` ho hraje.
 *
 * Svět se staví `buildRuntimeWorld`, tedy **tímtéž vstupním bodem**, jakým prošel
 * certifikát na serveru. Kdyby si stránka stavěla svět po svém, hrála by něco
 * jiného, než co verifikátor prohlásil za platné.
 */

import dynamic from 'next/dynamic';
import { useState } from 'react';

import Program from '@/components/pipeline/Program';
import WitnessPreview from '@/components/pipeline/WitnessPreview';
import PromptBar from '@/components/PromptBar';
import { buildRuntimeWorld } from '@/ir/build';
import type { WorldDocRuntime } from '@/sim/interpreter';

// ssr: false je povinné, ne kosmetické — WebGL kontext na serveru neexistuje
// a `<Canvas>` by při SSR spadl na `document`.
const Stage = dynamic(() => import('@/components/Stage'), { ssr: false });

/**
 * Emise → běh, nebo `null`.
 *
 * Emise, ze které se svět postavit nedá, je normální odpověď modelu, ne výjimka:
 * `/api/generate` vrací emisi tak, jak přišla, a validuje se až tady. Plátno pak
 * zůstane prázdné a uživatel dostane hlášku místo pádu.
 */
function worldFrom(emission: unknown): WorldDocRuntime | null {
  const sim = (emission as { sim?: unknown } | null)?.sim;
  if (sim === undefined || sim === null) return null;

  const built = buildRuntimeWorld(sim);
  return built.ok ? built.world : null;
}

export default function Page() {
  const [world, setWorld] = useState<WorldDocRuntime | null>(null);
  const [broken, setBroken] = useState(false);
  // Dvě emise v JEDNOM stavu, ne dva stavy vedle sebe: panel překladu ukazuje
  // ROZDÍL proti minulé větě, a posun „současná se stane minulou" musí být jeden
  // atomický krok. Dvě `useState` by ho složily ze dvou zápisů čtoucích zachycenou
  // hodnotu z minulého renderu — tedy z místa, kde se dá minout právě ta emise,
  // proti které se má porovnávat.
  const [programs, setPrograms] = useState<{ readonly current: unknown; readonly previous: unknown }>({
    current: null,
    previous: null,
  });

  return (
    <main style={{ position: 'relative', height: '100dvh', width: '100vw' }}>
      <PromptBar
        onWorld={(next) => {
          const built = worldFrom(next);
          setBroken(built === null);
          setWorld(built);
          setPrograms((was) => ({ current: next, previous: was.current }));
        }}
      />
      {broken ? (
        <p data-testid="world-broken" role="alert" style={BROKEN}>
          Model vrátil svět, který se nedá spustit.
        </p>
      ) : null}
      <Program emission={programs.current} previous={programs.previous} />
      <WitnessPreview world={world} />
      <Stage world={world} />
    </main>
  );
}

const BROKEN: React.CSSProperties = {
  position: 'absolute',
  bottom: '1rem',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 2,
  margin: 0,
  color: '#e8a33d',
};
