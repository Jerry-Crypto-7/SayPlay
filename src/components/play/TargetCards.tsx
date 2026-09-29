'use client';

/**
 * Karty cílů (P23-C T5, vzhled P33 T6). Vykreslení nad `targets.ts`: jedna
 * karta na cíl – ikona typu a jméno, číslo klávesy jen tam, kde je klávesnice
 * (CSS `hover: hover`), a vybraná karta řekne, co udělá další klepnutí.
 * Nepřítel není karta: stojí na liště bez tlačítka jako „avoid“. Lišta je
 * jeden řádek s vlastním posunem. Dispatch dělá rodič – tady se jen klepe.
 */

import type { RoleKind } from '@/play/spec';

import { type AvoidCard, secondTapLabel, type TargetCard } from './targets';
import { Icon, type IconName } from './ui';

const ICONS: Partial<Record<RoleKind, IconName>> = {
  collectible: 'collect',
  item: 'collect',
  key: 'collect',
  exit: 'flag',
  door: 'flag',
  destination: 'flag',
  checkpoint: 'flag',
  zone: 'flag',
};

export function TargetCards({ cards, avoid, kinds, selected, disabled, onTap }: {
  readonly cards: readonly TargetCard[];
  readonly avoid: readonly AvoidCard[];
  readonly kinds: ReadonlyMap<string, RoleKind>;
  readonly selected: string | null;
  readonly disabled: boolean;
  readonly onTap: (card: TargetCard) => void;
}) {
  if (cards.length === 0) {
    return <p className="play-targets-empty">This world offers nothing to walk to.</p>;
  }
  return (
    <nav className="play-targets" aria-label="Targets">
      {avoid.map((enemy) => (
        <span key={enemy.id} className="play-target play-target-avoid" data-testid={`play-avoid-${enemy.id}`}>
          <Icon name="warn" />
          <span className="play-target-label">{enemy.label}</span>
          <span className="play-target-next">avoid</span>
        </span>
      ))}
      {cards.map((card, index) => {
        const pressed = selected === card.id;
        const kind = kinds.get(card.id);
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
            <Icon name={(kind === undefined ? undefined : ICONS[kind]) ?? 'pin'} />
            <span className="play-target-label">{card.label}</span>
            {pressed && <span className="play-target-next">{secondTapLabel(card)}</span>}
          </button>
        );
      })}
    </nav>
  );
}
