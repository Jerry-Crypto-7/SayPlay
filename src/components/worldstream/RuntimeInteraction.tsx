'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RuntimeController } from '@/worldstream/runtime-controller';
import type { WorldDocRuntime } from '@/sim/interpreter';
import { guideRoute } from '@/worldstream/guide';
import { phraseGuideAnswer, type GuideSentence } from '@/worldstream/guide-answer';
import { SOLVE_BUDGET } from '@/model/repair';

/**
 * Které slovo otázky je cíl.
 *
 * **Poslední jméno věty**, nic chytřejšího: „How do I get to the gate?" končí
 * tím, na co se tazatel ptá, a stejně tak „where is the lever". Rozpoznávat
 * záměr by znamenalo druhý jazykový model v prohlížeči; tohle je pravidlo,
 * které se dá přečíst a předvídat.
 *
 * **Velikost písmen se nesnižuje.** `stableId` píše model a bývá `tallHive`;
 * `toLowerCase()` by z otázky udělal jméno, které ve světě není, a průvodce by
 * poctivě odpověděl „to tu není" na objekt, který porotce vidí před sebou.
 */
export function askedName(question: string): string | null {
  const words = question.split(/[^\p{L}\p{N}_.-]+/u).filter((word) => word !== '');
  const last = words.at(-1)?.replace(/^[.-]+|[.-]+$/gu, '') ?? '';
  return last === '' ? null : last;
}

/**
 * Odpověď průvodce nad dokumentem, který běží **teď**.
 *
 * Dokument je parametr, ne zapamatovaný stav, a je to celé rozhodnutí téhle
 * funkce: porotce přetočí čas a přepíše pravidlo, a odpověď z předchozí verze
 * světa by se od té dnešní nedala rozeznat — obě dávají smysl, jen jedna
 * z nich už neplatí.
 *
 * **Stopa se zahazuje** (`trace: []`). Běžící dokument nese vstupy, které
 * návštěvník do světa doopravdy poslal, kdežto otázka zní „kudy tam", ne „kudy
 * tam odsud, co už jsem naklikal". Hledat nad rozehranou stopou by odpovídalo
 * na jinou otázku, než jaká padla.
 *
 * Rozpočet je `SOLVE_BUDGET`, tedy tentýž, jakým si svět hledá vlastní vítěznou
 * cestu. Druhý strop by byl druhá pravda o tom, co tenhle systém ještě stihne.
 */
export function askGuide(document: WorldDocRuntime, question: string): GuideSentence | null {
  const asked = askedName(question);
  if (asked === null) return null;
  return phraseGuideAnswer(guideRoute({ ...document, trace: [] }, asked, SOLVE_BUDGET));
}

/** Controls send inputs; all positions, outcomes and rule IDs come back from the runtime. */
export default function RuntimeInteraction({ controller, readOnly = false, onRoute }: { readonly controller: RuntimeController; readonly readOnly?: boolean;
  /** Zastávky nalezené cesty pro scénu. Musí být stabilní napříč rendery. */
  readonly onRoute?: (highlight: readonly string[]) => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [selected, setSelected] = useState('0');
  const [message, setMessage] = useState('Choose a destination or an action. Activation requires reaching the sensor.');
  const [question, setQuestion] = useState('');
  /**
   * Odpověď **i s během, ze kterého pochází**.
   *
   * Uklidit ji při výměně běhu by bylo o řádek kratší a o jednu tichou chybu
   * horší: zapomenutý úklid vypadá úplně stejně jako hotová práce, protože
   * stará věta pořád dává smysl. Takhle se věta z minulých pravidel nemá jak
   * zobrazit — porovnává se s tím, co běží teď, a jinak ji nikdo nedostane.
   * Porotce tu výměnu udělá jedním kliknutím: „Return to original" a „Show
   * changed run" prohodí běh pod týmž panelem.
   */
  const [guide, setGuide] = useState<{ readonly controller: RuntimeController; readonly sentence: GuideSentence | null } | null>(null);
  const [asking, setAsking] = useState(false);
  const shown = guide?.controller === controller ? guide.sentence : null;
  useEffect(() => {
    setSelected('0');
    setMessage('Choose a destination or an action. Activation requires reaching the sensor.');
    // Zvýraznění bydlí ve stránce, ne tady, takže o výměně běhu musí slyšet.
    setAsking(false);
    onRoute?.([]);
  }, [controller, onRoute]);
  // Hledání běží **až za vykreslením**, aby bylo vidět, že se něco děje:
  // nevyhratelný svět vyčerpá `SOLVE_BUDGET` za jednotky sekund (P19 R6) a
  // synchronní hledání v obsluze kliknutí by na tu dobu zmrazilo obrázek
  // dřív, než by se stihlo cokoli překreslit.
  useEffect(() => {
    if (!asking) return;
    const answer = askGuide(controller.getReplayDocument(), question);
    setGuide({ controller, sentence: answer });
    setAsking(false);
    onRoute?.(answer?.highlight ?? []);
  }, [asking, controller, question, onRoute]);
  const action = controller.actions[Number(selected)];
  return <section aria-label="World interaction" style={{ flexBasis: '100%', display: 'grid', gap: 6, maxWidth: 420, maxHeight: '30dvh', overflow: 'auto' }}>
    <label>World action <select data-testid="runtime-action" value={selected}
      onChange={event => setSelected(event.target.value)} style={{ maxWidth: '100%', color: '#171717' }}>
      {controller.actions.map((entry, index) => <option key={index} value={index}>
        {entry.actionId === 'moveTo' ? 'Walk to' : entry.actionId} {entry.target ?? ''} ({entry.actor})
      </option>)}
    </select></label>
    <button type="button" data-testid="runtime-act" disabled={readOnly || !state.canInput || !action} onClick={() => {
      if (!action) return;
      const result = controller.dispatch(action);
      setMessage(!result.ok ? result.reason : result.runState === 'runtimeFault' ? 'Simulation fault; no transition applied.'
        : `Input at tick ${result.tick}. ${result.ruleIds.length ? `Applied: ${result.ruleIds.join(', ')}` : 'No rule applied; conditions were not met.'}`);
    }}>Perform action</button>
    <output data-testid="runtime-input-result" aria-live="polite">{message}</output>
    <label>Ask the guide <input data-testid="guide-question" value={question} placeholder="How do I get to the gate?"
      style={{ maxWidth: '100%', color: '#171717' }} onChange={event => setQuestion(event.target.value)} /></label>
    <button type="button" data-testid="guide-ask" disabled={asking || askedName(question) === null}
      onClick={() => setAsking(true)}>Ask the guide</button>
    <output data-testid="guide-answer" aria-live="polite">{asking ? 'Looking for a way…' : shown?.text ?? ''}</output>
    <details><summary>Action details</summary>
    <div data-testid="runtime-positions">{state.entities.filter(entity =>
      controller.actions.some(entry => entry.actor === entity.stableId)).map(entity =>
      <span key={entity.stableId}>{entity.stableId}: ({entity.x}, {entity.y}) </span>)}</div>
    <div data-testid="runtime-outcomes">{Object.entries(state.values).filter(([id]) =>
      id.startsWith('f:') || id.startsWith('t:') || id.endsWith(':locked')).map(([id, value]) =>
      <span key={id} data-testid={`runtime-value-${id}`} style={{ display: 'inline-block', marginRight: 8 }}>
        {id.startsWith('f:') ? `${id.slice(2)}: ${value ? 'on' : 'off'}`
          : id.endsWith(':locked') ? `${id.slice(2, -7)}: ${value ? 'locked' : 'unlocked'}`
            : `${id.slice(2)}: ${value} ticks`}
      </span>)}</div>
    <details><summary>Rule trace</summary>
      <ol data-testid="runtime-rule-trace" style={{ maxHeight: 110, overflow: 'auto', margin: 0, paddingLeft: 24 }}>
        {state.transitions.map((entry, index) => <li key={`${entry.tick}-${index}`}>
          Tick {entry.tick}: {entry.inputs.map(input => `${input.actionId} ${input.target ?? ''}`).join(', ') || 'Simulation'}
          {' → '}{entry.ruleIds.join(', ') || 'No rule applied'}
        </li>)}
      </ol>
    </details>
    </details>
  </section>;
}
