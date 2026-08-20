import { routePrompt } from '@/fallback/router';

import PlayView from './PlayView';

/**
 * Jediná routa fallbacku, která fallback opravdu spouští.
 *
 * Je to oracle úlohy T204 a bez ní by byl důkaz vakuózní: analýza bundlu nemá
 * co analyzovat, dokud `src/fallback/**` nevede z žádné routy. Rozhodnutí
 * routeru se počítá **na serveru** a vypisuje do HTML, takže smoke test v
 * `scripts/prove-fallback-isolation.mjs` čte skutečný verdikt izolovaného
 * artefaktu, ne jen to, že stránka vrátila 200.
 *
 * Sahá výhradně na `src/fallback/` a `src/kit/` — axiom architektonické
 * nezávislosti platí i pro routu, která je vystavuje.
 */

/** Anglicky, protože lexikon routeru je anglický (`LEXICON` v `router.ts`). */
const DEFAULT_PROMPT = 'collect three keys and reach the gate before the timer runs out';

const SHELL: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100dvh',
  width: '100vw',
};

const HEADER: React.CSSProperties = {
  padding: '0.7rem 0.9rem',
  borderBottom: '1px solid #1d2b30',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  fontSize: '0.85rem',
  lineHeight: 1.45,
};

export default async function PlayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requested = (await searchParams).prompt;
  const prompt =
    typeof requested === 'string' && requested.trim() !== '' ? requested : DEFAULT_PROMPT;
  const decision = routePrompt(prompt);

  return (
    <main style={SHELL}>
      <header style={HEADER}>
        <span data-testid="route-prompt">{prompt}</span>
        <span>
          <b data-testid="route-kind">{decision.kind}</b>{' '}
          <span data-testid="route-archetype">
            {decision.kind === 'archetype' ? decision.archetype : decision.nearest}
          </span>{' '}
          <span data-testid="route-layout">{decision.sceneLayout}</span>
        </span>
        <span data-testid="route-reason">{decision.reason}</span>
        {decision.kind === 'archetype' ? (
          <span data-testid="play-mode">
            Hraje se ručně — šipky nebo WASD, jeden pohyb na tik.
          </span>
        ) : null}
      </header>
      <PlayView decision={decision} prompt={prompt} />
    </main>
  );
}
