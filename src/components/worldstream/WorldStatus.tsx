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
 * berou pozornost navzájem, takže je to teď jeden prvek se čtyřmi stavy.
 *
 * **`building` přibylo s hlavní cestou** (`T47-t21bunblock`): worldstreamová
 * relace běží vteřiny a mezi větou a světem musí něco stát. Stará herní scéna
 * na `/classic` ho neposílá — emise tam padne v jednom kroku, takže by ta věta
 * byla vidět jeden snímek a lhala by o tom, že se čeká.
 */

/** Co se o světě dá pravdivě říct. Pořadí je pořadí, ve kterém se stavy střídají. */
export type WorldStatusState = 'empty' | 'building' | 'broken' | 'live';

/**
 * Copy pro každý stav. Anglicky, protože **viditelná měď produktu je anglicky**
 * (`CLAUDE.md`, design book §15.6) — věty se do pole píšou anglicky a české
 * rozhraní nad anglickým vstupem je rozpor.
 */
const SENTENCE: Record<WorldStatusState, string> = {
  empty: 'Describe a place that could not exist before.',
  building: 'Writing the world.',
  broken: 'That sentence did not produce a world that can run.',
  live: 'The world is live.',
};

export default function WorldStatus({
  state,
  detail = null,
}: {
  readonly state: WorldStatusState;
  /**
   * Proč se svět nepostavil, **větou ze serveru nebo ze stavby** — ne kódem
   * a ne výjimkou poskytovatele; do proudu relace se nic jiného nedostane
   * (`SESSION_FAULTS`).
   *
   * Připisuje se za obecnou větu, ne místo ní: obecná věta říká, co se stalo,
   * detail říká proč, a porotce, kterému detail nic neřekne, tak pořád ví,
   * na čem je. Mimo `broken` se ignoruje — v ostatních stavech není o čem.
   */
  readonly detail?: string | null;
}) {
  const broken = state === 'broken';
  return (
    <p
      className="ws-status"
      data-testid={broken ? 'world-broken' : 'world-status'}
      data-state={state}
      role={broken ? 'alert' : undefined}
    >
      {SENTENCE[state]}
      {broken && detail !== null && detail !== '' ? (
        <span data-testid="world-fault" style={DETAIL}>
          {' '}
          {detail}
        </span>
      ) : null}
    </p>
  );
}

const DETAIL: React.CSSProperties = { opacity: 0.7 };
