'use client';

/**
 * Stav světa jako **jedna věta**, ne panel logů (design book §15.3, §16).
 *
 * Do vlny 0 rozhraní o stavu mlčelo a místo něj stálo v rozích pět průsvitných
 * karet s vnitřnostmi potrubí. Karta ukazuje, co systém dělá; věta říká, na čem
 * uživatel je — a to je jediná informace, kterou v tu chvíli potřebuje.
 *
 * **Věta nikdy neslibuje víc, než se doopravdy děje.** Design book má pro živý
 * svět copy `The world is live. Its detailed forms are still arriving.`, jenže
 * dokud materializace detailu neexistuje (vlna 3), byla by druhá polovina lež
 * v produktu. Doplní se, až bude co dorazit — ne dřív.
 *
 * **Rozbitý svět nese `role="alert"` a `data-testid="world-broken"`.** Dřív to
 * byl samostatný odstavec uprostřed obrazovky vedle stavu; dvě věty o tomtéž si
 * berou pozornost navzájem, takže je to teď jeden prvek se třemi stavy.
 */

/** Co se o světě dá pravdivě říct. Pořadí je pořadí, ve kterém se stavy střídají. */
export type WorldStatusState = 'empty' | 'broken' | 'live';

/**
 * Copy pro každý stav. Anglicky, protože **viditelná měď produktu je anglicky**
 * (`CLAUDE.md`, design book §15.6) — věty se do pole píšou anglicky a české
 * rozhraní nad anglickým vstupem je rozpor.
 */
const SENTENCE: Record<WorldStatusState, string> = {
  empty: 'Describe a place that could not exist before.',
  broken: 'That sentence did not produce a world that can run.',
  live: 'The world is live.',
};

export default function WorldStatus({ state }: { readonly state: WorldStatusState }) {
  return (
    <p
      className="ws-status"
      data-testid={state === 'broken' ? 'world-broken' : 'world-status'}
      data-state={state}
      role={state === 'broken' ? 'alert' : undefined}
    >
      {SENTENCE[state]}
    </p>
  );
}
