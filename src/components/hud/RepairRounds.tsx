'use client';

/**
 * Kola opravy — porotce vidí, jak se model opravuje (vlna 2 T5).
 *
 * ## Proč to musí být vidět
 *
 * Vlna 2 stojí na jedné větě: *„odmítnutí je vstup zpátky do modelu."* Bez
 * tohohle panelu je to tvrzení v dokumentaci. S ním je to pohyb na obrazovce:
 * kolo 1 padlo na tomhle, model dostal důvod, kolo 2 prošlo. Certifikovaný svět
 * na plátně vypadá stejně, ať vznikl napoprvé nebo napotřetí — rozdíl je právě
 * a jen tady.
 *
 * ## Věta, ne kód
 *
 * Ukazuje se **táž věta, kterou dostal model** (`rejectionSentence()` z T2), ne
 * `STEP_UNREACHABLE`. Kód porotci neřekne nic a vypadá jako technický log, který
 * má přeskočit; věta s adresou mu ukáže, že systém vadu doopravdy pojmenoval.
 * Je to zároveň poctivé: na obrazovce stojí přesně to, co šlo do modelu, ne
 * hezčí převyprávění.
 *
 * ## Kdy se panel neukáže
 *
 * Při jednom kole. Jedno kolo znamená, že se nic neopravovalo — a řádek
 * „Round 1 — certified" by zabíral roh a nic nesděloval, stejně jako trvalé
 * „model připraven" u `ModelProgress`. Panel je zpráva o opravě, ne stavový
 * řádek.
 *
 * ⚠ **Ukotvení nese sloupec v `src/app/page.tsx`, ne tahle komponenta.** Panel,
 * který si sáhne na vlastní roh, si lehne na jiný — stalo se to dvakrát a
 * pokaždé to leželo červené několik dní.
 */

import { rejectionSentence } from '@/model/local/rejection-prompt';

import type { Round } from '@/model/local/emit';

export type RoundState = 'rejected' | 'certified';

export interface RoundLine {
  readonly attempt: number;
  readonly state: RoundState;
  /** Co se v tom kole stalo, větou. U odmítnutí doslova to, co dostal model. */
  readonly text: string;
}

/**
 * Kola na řádky. Oddělené od renderu, protože tohle je jediná část panelu, kde
 * se dá tiše splést — a repozitář komponenty netestuje, testuje jejich čisté
 * funkce (`captionFor`, `promptOutcome`, `repairLines`).
 */
export function roundLines(rounds: readonly Round[]): readonly RoundLine[] {
  return rounds.map((round) => ({
    attempt: round.attempt,
    state: round.rejection === null ? 'certified' : 'rejected',
    text:
      round.rejection === null
        ? 'The system certified this world and it is the one now running on the canvas.'
        : rejectionSentence(round.rejection),
  }));
}

/**
 * Nadpis podle toho, jak to dopadlo. Panel se ukazuje jen po víc než jednom
 * kole, takže obě varianty jsou o opravě — jedna se povedla, druhá ne.
 */
export function roundsCaption(lines: readonly RoundLine[]): string {
  const last = lines[lines.length - 1];
  return last !== undefined && last.state === 'certified'
    ? 'The model was told what was wrong and corrected itself.'
    : 'The model was told what was wrong and could not fix it.';
}

/**
 * Má panel co říct?
 *
 * Jedno kolo znamená, že se nic neopravovalo. Je to čistá funkce, a ne podmínka
 * schovaná v renderu, protože je to jediné pravidlo o tom, kdy panel na
 * obrazovce je — a repozitář soudí čisté funkce, ne komponenty.
 */
export function showsRounds(rounds: readonly Round[]): boolean {
  return rounds.length >= 2;
}

export default function RepairRounds({ rounds }: { readonly rounds: readonly Round[] }) {
  // Jedno kolo není oprava. Panel je zpráva, ne stavový řádek.
  if (!showsRounds(rounds)) return null;

  const lines = roundLines(rounds);

  return (
    <section data-testid="repair-rounds" style={PANEL}>
      <p style={CAPTION}>{roundsCaption(lines)}</p>
      <ol style={LIST}>
        {lines.map((line) => (
          <li key={line.attempt} data-testid="repair-round" data-state={line.state} style={ITEM}>
            <span style={line.state === 'certified' ? BADGE_OK : BADGE_BAD}>
              {`Round ${String(line.attempt)} · ${line.state}`}
            </span>
            <span style={TEXT}>{line.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const PANEL: React.CSSProperties = {
  maxWidth: '22rem',
  padding: '0.5rem 0.7rem',
  borderRadius: 6,
  background: 'rgba(11, 18, 20, 0.86)',
  color: '#9fc0c2',
  font: '12px/1.5 ui-monospace, monospace',
  // Tři kola s celými větami jsou vysoká zeď. Sloupec má strop výšky, takže bez
  // vlastního posuvníku by panel odstrčil náhled vítězné cesty z obrazovky.
  maxHeight: '14rem',
  overflowY: 'auto',
  // Sloupec je průchozí pro kurzor a panel si průchodnost vypíná sám. Tenhle ji
  // vypnout **nesmí**: má vlastní posuvník, a posuvník, který nebere kurzor, je
  // jen ozdoba — porotce by třetí kolo nepřečetl. Stejně to má vedle stojící
  // `WitnessPreview`; čistě informační `ModelProgress` naopak zůstává průchozí.
  pointerEvents: 'auto',
};

const CAPTION: React.CSSProperties = { margin: '0 0 0.4rem', color: '#cfe3e4' };

const LIST: React.CSSProperties = { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '0.4rem' };

const ITEM: React.CSSProperties = { display: 'grid', gap: '0.15rem' };

const BADGE_BASE: React.CSSProperties = { font: '11px/1.4 ui-monospace, monospace', letterSpacing: '0.02em' };

const BADGE_BAD: React.CSSProperties = { ...BADGE_BASE, color: '#d98d4a' };

const BADGE_OK: React.CSSProperties = { ...BADGE_BASE, color: '#2f9e8f' };

const TEXT: React.CSSProperties = { color: '#9fc0c2', overflowWrap: 'anywhere' };
