'use client';

/**
 * Karty cílů (P23-C T5). Vykreslení nad `targets.ts`: jedna karta na cíl,
 * číslo klávesy, popisek a co udělá další klepnutí. Vybraná karta nese
 * `aria-pressed`. Dispatch dělá rodič – tady se jen klepe.
 */

import { secondTapLabel, type TargetCard } from './targets';

export function TargetCards({ cards, selected, disabled, onTap }: {
  readonly cards: readonly TargetCard[];
  readonly selected: string | null;
  readonly disabled: boolean;
  readonly onTap: (card: TargetCard) => void;
}) {
  if (cards.length === 0) {
    return <p className="play-targets-empty">This world offers nothing to walk to.</p>;
  }
  return (
    <nav className="play-targets" aria-label="Targets">
      {cards.map((card, index) => {
        const pressed = selected === card.id;
        return (
          <button
            key={card.id}
            type="button"
            className="play-target"
            data-testid={`play-target-${card.id}`}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={() => onTap(card)}
          >
            {index < 9 && <span className="play-target-key">{index + 1}</span>}
            <span className="play-target-label">{card.label}</span>
            <span className="play-target-next">{pressed ? secondTapLabel(card) : 'Go'}</span>
          </button>
        );
      })}
    </nav>
  );
}
