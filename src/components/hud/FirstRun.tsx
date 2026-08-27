'use client';

/**
 * Prázdný stav plátna — co vidí člověk, který přišel a ještě nic nenapsal.
 *
 * Do T25 tu nebylo nic. Studený návštěvník dostal černou plochu a jedno pole
 * nahoře; co se stane po odeslání, věděl jen ten, kdo četl zdroják nebo přihlášku.
 * Na porotě je to ta nejdražší vteřina, jaká v produktu je — než někdo pochopí,
 * co má udělat, nemá důvod to udělat.
 *
 * **Nic tu není interaktivní, a je to záměr.** Věta se píše nahoře do
 * `PromptBar`; kdyby tady stálo tlačítko, stalo by se prvním ovládacím prvkem
 * stránky a odvedlo by pozornost od pole, do kterého se doopravdy píše.
 * `e2e/render-quality.spec.ts` na to má aserci — první interaktivní prvek musí
 * být pořád vstup pro větu.
 *
 * **Ukázkové věty jsou anglicky schválně.** Rozpoznávač tvarů vět
 * (`src/model/local/shapes.ts`) je celý z anglických regulárních výrazů, takže
 * česky napsaná věta projde a rozbije se až o produkt — a to je přesně ten druh
 * selhání, které si nikdo nespojí s jazykem. Totéž rozhodnutí má diktování
 * v T23.
 */

import { UI_TOKENS } from '@/kit';

/**
 * Věty, které tady stojí jako ukázka.
 *
 * Jsou to tvary, které rozpoznávač umí (`SHAPES` v `src/model/local/shapes.ts`) —
 * ne libovolné hezké věty. Kdyby tu stálo něco, co produkt nepostaví, byla by
 * nápověda past.
 *
 * **Ani jedna není opsaná z placeholderu vstupu.** Ta věta už na obrazovce je;
 * zopakovaná o kus níž jen zabírá místo a vypadá jako chyba.
 */
const EXAMPLES: readonly string[] = [
  // `beat-the-clock` — věta o čase vyrobí svět s odpočtem.
  'a flooded vault I must escape in sixty seconds before the water rises',
  // `patrolling-character` — hlídka, které se hráč musí vyhnout.
  'a courtyard with two guards patrolling between four pillars',
];

export default function FirstRun() {
  return (
    <div data-testid="first-run" style={PANEL}>
      <p style={LEAD}>Write a sentence. A playable world gets built from it.</p>
      <ol style={STEPS}>
        <li>
          <span style={ORDINAL}>1</span> Describe a room in the field above.
        </li>
        <li>
          <span style={ORDINAL}>2</span> The world assembles in front of you, piece by piece.
        </li>
        <li>
          <span style={ORDINAL}>3</span> Number keys walk to the targets, space picks things up.
        </li>
      </ol>
      <p style={TRY}>Try one of these:</p>
      <ul style={SAMPLES}>
        {EXAMPLES.map((example) => (
          <li key={example} data-testid="first-run-example" style={SAMPLE}>
            {example}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Střed plátna, ne roh.
 *
 * Rohy patří sloupcům v `src/app/page.tsx` (konvence v `CLAUDE.md`) a horní
 * pruh `PromptBar`u. Tohle je prázdný stav scény, takže stojí tam, kde ta scéna
 * bude — uprostřed. `pointerEvents: 'none'` je nutnost, ne úklid: panel překrývá
 * plátno a bez toho by bral kliknutí, která patří světu.
 */
const PANEL: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 1,
  maxWidth: 'min(34rem, calc(100vw - 3rem))',
  textAlign: 'center',
  color: UI_TOKENS.text,
  font: '14px/1.6 ui-monospace, monospace',
  pointerEvents: 'none',
};

const LEAD: React.CSSProperties = {
  margin: '0 0 1.1rem',
  fontSize: '1.15rem',
  color: UI_TOKENS.text,
};

const STEPS: React.CSSProperties = {
  margin: '0 0 1.3rem',
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.4rem',
  color: UI_TOKENS.muted,
  textAlign: 'left',
};

const ORDINAL: React.CSSProperties = {
  display: 'inline-block',
  width: '1.4rem',
  color: UI_TOKENS.accent,
};

const TRY: React.CSSProperties = {
  margin: '0 0 0.4rem',
  color: UI_TOKENS.muted,
  fontSize: '0.8rem',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const SAMPLES: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.35rem',
};

const SAMPLE: React.CSSProperties = {
  padding: '0.35rem 0.6rem',
  textAlign: 'left',
  borderRadius: 4,
  border: '1px solid #24383d',
  background: 'rgba(12, 22, 26, 0.72)',
  color: UI_TOKENS.text,
  fontSize: '0.85rem',
};
