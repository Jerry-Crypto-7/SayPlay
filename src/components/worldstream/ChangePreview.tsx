'use client';

/**
 * **Rozsah změny dřív, než se cokoli změní** (P15 T23, design book §4 dějství III
 * a §21).
 *
 * Druhá věta je jediné místo produktu, kde porotce něco **rozhoduje**. Panel
 * proto neukazuje, co se stalo, ale co by se stalo — a stojí mezi větou a
 * commitem jako druhé, vědomé kliknutí.
 *
 * ## Tři stavy, a každý má svůj vlastní důvod existovat
 *
 * 1. **`candidates`** — věta ukázala na dva objekty stejně přesně, takže si
 *    systém vybírat nemá. Nabídka je podle §24 jediný způsob, jakým se druhá
 *    věta smí splést: **nabídkou, ne tichým odhadem**. Dokud porotce nevybere,
 *    nezmění se ani revize, ani stav, ani jedno placené volání — grounding
 *    v `worldstream-refine.ts` běží před modelem a je zadarmo.
 * 2. **`preview`** — plán existuje a je uložený u relace. Ukazuje se, co se
 *    změní **i co zůstane**; druhá polovina je slib „bez resetu" a bez ní se
 *    ta věta nedá ověřit očima.
 * 3. **`refused`** — model odpověděl něco, co brána nepustila, nebo se
 *    nedovolal. Poctivá věta je lepší než prázdný panel, který vypadá jako by
 *    se nic nestalo.
 *
 * ## Rozsah se čte jako věta, ne jako tři čísla
 *
 * `scope` ze serveru je `{ shape: boolean, behavior: number, appearance: number }`.
 * Porotce nemá vědět, co je JSON Patch operace, takže se to překládá do jmen
 * fazet — *shape · behavior · appearance* — a počty jdou do `title`, ne do
 * hlavního textu. Faseta, která je nulová, se **nezobrazuje**: prázdné „0
 * appearance changes" je šum, ze kterého se nedá poznat, že se vzhled nemění.
 *
 * ## Proč `Apply` a ne `Commit`
 *
 * `commit` je slovo z API a z gitu. Porotce, který vidí rozsah a chce ho
 * potvrdit, hledá „použij to" — a `RULES.md` §3.3 mu dává právo zkoušet
 * vlastní věty, takže rozhraní má mluvit jeho jazykem, ne jazykem route.
 */

import type { ReactElement } from 'react';

/** Kandidát z groundingu. Kopíruje tvar, který vrací route `changes`. */
export interface ChangeCandidate {
  readonly stableId: string;
  readonly label: string;
  /** Jméno, kterým se objekt do věty trefil. `null`, když se netrefil vůbec. */
  readonly matched: string | null;
}

/** Rozsah plánu — přesně to, co vrací route. */
export interface ChangeScope {
  readonly shape: boolean;
  readonly behavior: number;
  readonly appearance: number;
  /** Věta zakládá objekt, který ve světě nebyl (P21 T8). */
  readonly addition?: boolean;
}

export type ChangeState =
  | {
      readonly kind: 'candidates';
      /** `NO_MATCH` nabídne celý svět, `AMBIGUOUS` jen ty shodné, `UNKNOWN_ID` taky. */
      readonly reason: 'NO_MATCH' | 'AMBIGUOUS' | 'UNKNOWN_ID';
      readonly candidates: readonly ChangeCandidate[];
    }
  | {
      readonly kind: 'preview';
      readonly changeId: string;
      readonly summary: string;
      readonly target: { readonly stableId: string; readonly label: string };
      readonly scope: ChangeScope;
      /** Popisky objektů, kterých se změna **nedotkne**. */
      readonly preserved: readonly string[];
    }
  | { readonly kind: 'refused'; readonly message: string };

export interface ChangePreviewProps {
  readonly state: ChangeState;
  /** Porotce vybral jeden z kandidátů. Věta se pošle znovu, tentokrát s `stableId`. */
  readonly onChoose: (stableId: string) => void;
  /** Potvrzení plánu. Teprve tenhle klik smí zvednout revizi. */
  readonly onApply: () => void;
  /** Zahození plánu. Nesmí zvednout revizi ani počet volání. */
  readonly onDiscard: () => void;
  /** Běží právě commit? Dvojklik na `Apply` by jinak poslal dvě žádosti. */
  readonly busy?: boolean;
}

/**
 * Rozsah jako seznam vět. Nulová faseta se vynechává, ne vypisuje nulou.
 *
 * Exportované kvůli testu: repo nemá testing-library, takže se komponenty soudí
 * Playwrightem — a jediný kus rozhodování, který v týhle komponentě je, se dá
 * změřit levněji jako čistá funkce. Harness `/dev/refine` vydává schválně jen
 * tvarovou změnu, takže neprázdné fasety by e2e stejně neuviděla.
 */
export function scopeParts(scope: ChangeScope): readonly string[] {
  const parts: string[] = [];
  if (scope.addition) parts.push('a new object');
  if (scope.shape) parts.push('a new shape');
  if (scope.behavior > 0)
    parts.push(`${scope.behavior} behaviour ${scope.behavior === 1 ? 'change' : 'changes'}`);
  if (scope.appearance > 0)
    parts.push(`${scope.appearance} appearance ${scope.appearance === 1 ? 'change' : 'changes'}`);
  return parts;
}

export default function ChangePreview({
  state,
  onChoose,
  onApply,
  onDiscard,
  busy = false,
}: ChangePreviewProps): ReactElement {
  if (state.kind === 'candidates') {
    return (
      <section className="ws-change" data-testid="change-preview" data-kind="candidates">
        <p className="ws-change-lead">
          {state.reason === 'NO_MATCH'
            ? 'That sentence does not name anything standing in this world. Pick the object you meant:'
            : 'That sentence fits more than one object. Pick the one you meant:'}
        </p>
        <ul className="ws-change-candidates">
          {state.candidates.map((candidate) => (
            <li key={candidate.stableId}>
              <button
                type="button"
                data-testid="change-candidate"
                data-stable-id={candidate.stableId}
                onClick={() => onChoose(candidate.stableId)}
              >
                {candidate.label}
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (state.kind === 'refused') {
    return (
      <section className="ws-change" data-testid="change-preview" data-kind="refused">
        <p className="ws-change-lead" data-testid="change-refusal">
          {state.message}
        </p>
        <div className="ws-change-actions">
          <button type="button" data-testid="change-discard" onClick={onDiscard}>
            Dismiss
          </button>
        </div>
      </section>
    );
  }

  const parts = scopeParts(state.scope);
  return (
    <section className="ws-change" data-testid="change-preview" data-kind="preview">
      <p className="ws-change-lead">
        <strong data-testid="change-target">{state.target.label}</strong>
        {' — '}
        <span data-testid="change-summary">{state.summary}</span>
      </p>
      <p className="ws-change-scope" data-testid="change-scope">
        {parts.length === 0 ? 'Nothing would change.' : `This changes ${parts.join(', ')}.`}
      </p>
      {/* Druhá polovina slibu „bez resetu": co zůstane. Jména, ne počet —
          porotce má poznat svůj svět, ne přečíst číslo. */}
      {state.preserved.length > 0 && (
        <p className="ws-change-preserved" data-testid="change-preserved">
          Not named by this change: {state.preserved.join(', ')}
        </p>
      )}
      <div className="ws-change-actions">
        <button
          type="button"
          data-testid="change-apply"
          onClick={onApply}
          disabled={busy}
          className="ws-change-primary"
        >
          {busy ? 'Applying…' : 'Apply'}
        </button>
        <button type="button" data-testid="change-discard" onClick={onDiscard} disabled={busy}>
          Discard
        </button>
      </div>
    </section>
  );
}
