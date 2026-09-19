'use client';

/**
 * Why — **jeden tik rozepsaný na vstup → pravidlo → zápis → co to spustilo dál**
 * (P22 T8, řeší G10).
 *
 * Do T8 porotce viděl, že se něco stalo: v `Rule trace` stálo jméno pravidla a
 * v hodnotách nová čísla. Neviděl **proč** — které pravidlo které číslo
 * přepsalo a co z toho o pár tiků později vyplynulo. Přesně to T7 zaznamenala
 * vedle stavu (`StepResult.explain`, kruh v `runtime-controller.ts`) a tenhle
 * panel to čte.
 *
 * ## Co je tady pravda a odkud
 *
 * Všechno pochází z **jednoho běhu** — `controller`, tentýž, nad kterým stojí
 * ovládání. Vstup tiku z `getInputEffects`, pravidla a zápisy z `explainTick`,
 * následky z `downstreamOf`. Panel nic nepočítá a nic si nepamatuje: přetočí-li
 * porotce čas před ten tik, kruh se od něj smaže a panel poctivě řekne, že se
 * v něm nic nestalo. Ukazovat zápisy z tiku, který ve vráceném stavu nenastal,
 * by byla ta věrohodně vypadající lež, kterou `e2e/why-panel.spec.ts` pinuje.
 *
 * Věta spouštěče je z `describe.ts` — týž překlad pravidla, jaký čte panel
 * `Program`. Druhý slovník by se rozešel s prvním po jednom přidaném druhu
 * události.
 *
 * ## Pravidla, která hranu měla a stráž je zastavila
 *
 * `guardHeld: false` se vypisuje taky, bez zápisů. „Proč se dveře neotevřely"
 * je stejně dobrá otázka jako „proč se otevřely", a T7 tu větev zaznamenává
 * právě proto. Věta „No rule fired at this tick" platí, když **žádné** pravidlo
 * nezapsalo — stráží zastavené pravidlo tik neprobudilo.
 */

import { useMemo, useSyncExternalStore } from 'react';

import { describeEmission } from '@/components/pipeline/describe';
import type { WorldDoc } from '@/ir/worlddoc';
import type { RuntimeController } from '@/worldstream/runtime-controller';

/** Kolik tiků dopředu se hledají následky. Táž výchozí mez jako `downstreamOf`. */
const HORIZON = 20;

export default function WhyPanel({
  controller,
  tick,
  document,
  onClose,
}: {
  readonly controller: RuntimeController;
  /** Tik, na jehož značku porotce klikl. */
  readonly tick: number;
  /** Dokument, ze kterého běh vznikl — kvůli větám spouštěčů. */
  readonly document: WorldDoc;
  readonly onClose: () => void;
}) {
  // Následky dobíhají s časem: pravidlo, které tenhle tik spustil, může
  // vystřelit až za pár tiků, a panel to má ukázat bez dalšího kliknutí.
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  const sentences = useMemo(() => {
    const byRule = new Map<string, string>();
    for (const line of describeEmission(document)) {
      if (line.section === 'rules') byRule.set(line.id.slice('rules/'.length), line.text);
    }
    return byRule;
  }, [document]);

  const inputs = controller.getInputEffects(tick).filter((entry) => entry.input.tick === tick);
  const firings = controller.explainTick(tick);
  const fired = firings.some((firing) => firing.guardHeld);
  const downstream = controller.downstreamOf(tick, HORIZON);

  return (
    <section className="ws-why" data-testid="why-panel" data-tick={String(tick)} aria-label="Why this happened">
      <header className="ws-why-head">
        <h2 className="ws-why-title">Why · tick {String(tick)}</h2>
        <button type="button" className="ws-why-close" data-testid="why-close" onClick={onClose}>
          Close
        </button>
      </header>

      <p className="ws-why-input" data-testid="why-input">
        {inputs.length === 0
          ? 'No visitor input at this tick.'
          : inputs.map((entry) => `${entry.input.actor} · ${entry.input.actionId}${entry.input.target === undefined ? '' : ` ${entry.input.target}`}`).join(', ')}
      </p>

      {fired ? null : <p className="ws-why-empty" data-testid="why-empty">No rule fired at this tick</p>}

      <ol className="ws-why-rules">
        {firings.map((firing) => (
          <li key={firing.ruleId} className="ws-why-rule" data-testid="why-rule" data-rule-id={firing.ruleId} data-guard-held={firing.guardHeld}>
            <strong>{firing.ruleId}</strong>
            <span className="ws-why-sentence">{sentences.get(firing.ruleId) ?? firing.ruleId}</span>
            {firing.guardHeld ? (
              <ul className="ws-why-writes">
                {firing.writes.map((write, index) => (
                  <li key={`${write.slot}-${String(index)}`} data-testid="why-write">
                    {write.slot}: {String(write.before)} → {String(write.after)}
                  </li>
                ))}
                {firing.writes.length === 0 ? <li>No slot changed</li> : null}
              </ul>
            ) : (
              <span className="ws-why-guard">Its condition did not hold, so nothing was written</span>
            )}
          </li>
        ))}
      </ol>

      <section className="ws-why-next" data-testid="why-downstream">
        <h3 className="ws-why-subtitle">What this triggered next</h3>
        {downstream.length === 0 ? (
          <p className="ws-why-empty">Nothing read these values within the next {String(HORIZON)} ticks</p>
        ) : (
          <ol className="ws-why-rules">
            {downstream.map((entry) => (
              <li key={`${String(entry.tick)}-${entry.ruleId}`} data-testid="why-downstream-rule" data-rule-id={entry.ruleId} data-tick={String(entry.tick)}>
                tick {String(entry.tick)} · <strong>{entry.ruleId}</strong> read {entry.reads.join(', ')}
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
