'use client';

/**
 * „Why this game is fair“ (P73B T3/T4): co publikační brána o hře ověřila, třemi větami pro hráče, a pod nimi
 * přehrání robota, kterým verze prošla. Otevírá ho řádek „Checked“ na kartě startu i karta výsledku.
 * Věty jsou jen z `CheckFacts` – co brána nekontrolovala, list neříká.
 */

import type { CheckFacts } from './lab';
import { Button, Icon, Sheet } from './ui';

/** Hra, kterou prohrát nejde (`lose === null`), větu o nečinném hráči vynechá. */
const idleShown = (checks: CheckFacts, lose: string | null): boolean => checks.idleNeverWins && lose !== null;

/** „Checked: a robot beat it · doing nothing never wins · plays the same every time“. */
export function checkedLineOf(checks: CheckFacts, lose: string | null): string {
  const parts = ['a robot beat it', idleShown(checks, lose) ? 'doing nothing never wins' : null, checks.replayEqual ? 'plays the same every time' : null];
  return `Checked: ${parts.filter((part) => part !== null).join(' · ')}`;
}

export function fairLinesOf(checks: CheckFacts, lose: string | null): readonly string[] {
  return [
    `A robot beat it in ${checks.botSeconds.toFixed(1)} s.`,
    ...(idleShown(checks, lose) ? ['Doing nothing never wins.'] : []),
    ...(checks.replayEqual ? ['Replaying the robot gives the same result every time.'] : []),
  ];
}

export function FairSheet({
  open,
  onClose,
  checks,
  lose,
  onWatch,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly checks: CheckFacts;
  /** Jak se prohrává (`loseLineOf`); `null` = hra prohrát nejde. */
  readonly lose: string | null;
  /** Přehrání „Show me how“; chybí = hra ho nemá (mřížka, fyzika se ještě načítá). */
  readonly onWatch?: () => void;
}) {
  return (
    <Sheet open={open} title="Why this game is fair" onClose={onClose} className="play-fair-sheet">
      <ul className="play-fair-list" data-testid="play-fair-list">
        {fairLinesOf(checks, lose).map((line) => (
          <li key={line}>
            <Icon name="check" />
            {line}
          </li>
        ))}
      </ul>
      {onWatch !== undefined && (
        <Button variant="secondary" data-testid="play-fair-watch" onClick={onWatch}>
          <Icon name="play" />
          Watch the robot win
        </Button>
      )}
    </Sheet>
  );
}
