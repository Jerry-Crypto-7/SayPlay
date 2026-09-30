'use client';

/**
 * Lišta cílů (P23-C T5, P33 T6, od P34 T5 čipy kitu `.sp-chip`). Vykreslení
 * nad `targets.ts`: jeden čip na cíl – ikona typu a jméno, číslo klávesy jen
 * tam, kde je klávesnice (CSS `hover: hover`), a vybraný čip (inkoustový,
 * `.is-selected`) řekne, co udělá další klepnutí. Nepřítel není tlačítko:
 * rajčatový čip „avoid“. Lišta je jeden řádek s vlastním posunem nad dolní
 * řadou HUD. Dispatch dělá rodič – tady se jen klepe.
 */

import type { RoleKind } from '@/play/spec';

import { type AvoidCard, secondTapLabel, type TargetCard } from './targets';
import { Icon, type IconName } from './ui';

const ICONS: Partial<Record<RoleKind, IconName>> = {
  collectible: 'egg',
  item: 'egg',
  key: 'egg',
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
    return <p className="play-targets-empty">This game has nothing to walk to.</p>;
  }
  return (
    <nav className="play-targets" aria-label="Targets">
      {avoid.map((enemy) => (
        <span key={enemy.id} className="sp-chip play-target play-target-avoid" data-testid={`play-avoid-${enemy.id}`}>
          <Icon name="alert" />
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
            className={pressed ? 'sp-chip play-target is-selected' : 'sp-chip play-target'}
            data-testid={`play-target-${card.id}`}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={() => onTap(card)}
          >
            {index < 9 && <span className="play-target-key">{index + 1}</span>}
            <Icon name={(kind === undefined ? undefined : ICONS[kind]) ?? 'trophy'} />
            <span className="play-target-label">{card.label}</span>
            {pressed && <span className="play-target-next">{secondTapLabel(card)}</span>}
          </button>
        );
      })}
    </nav>
  );
}
