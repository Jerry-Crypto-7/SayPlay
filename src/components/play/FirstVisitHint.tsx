/**
 * Nápověda první návštěvy nad polem věty (P44D T12): pět vět, které měřeně
 * dají hru, a „Try your own“. Klepnutí na větu ji vloží do pole stejně jako
 * karta nápadu – hru spustí až „Make it!“. Po první hře nebo po „Not now“ se
 * už neukáže (`sp-first-visit` v `localStorage`).
 *
 * Bez úložiště (soukromé okno, zakázané cookies – už samo `window.localStorage`
 * hodí `SecurityError`) se nápověda ukáže při každé návštěvě a stránka
 * funguje dál: proto obě funkce berou úložiště přes getter uvnitř `try`.
 */

import { FIRST_VISIT_TITLE, JUDGE_PICKS, NOT_NOW, TRY_YOUR_OWN } from './starters';
import { Button, Chip } from './ui';

export const FIRST_VISIT_KEY = 'sp-first-visit';

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;

const browserStorage = (): KeyStore => window.localStorage;

export function isFirstVisit(storage: () => KeyStore = browserStorage): boolean {
  try {
    return storage().getItem(FIRST_VISIT_KEY) === null;
  } catch {
    return true;
  }
}

export function markVisited(storage: () => KeyStore = browserStorage): void {
  try {
    storage().setItem(FIRST_VISIT_KEY, '1');
  } catch {
    // Bez úložiště se nápověda příště ukáže znovu; nic víc se nestane.
  }
}

export function FirstVisitHint({
  disabled,
  onPick,
  onTryOwn,
  onClose,
}: {
  readonly disabled: boolean;
  readonly onPick: (sentence: string) => void;
  readonly onTryOwn: () => void;
  readonly onClose: () => void;
}) {
  return (
    <section className="sp-card play-first-visit" data-testid="play-first-visit" aria-labelledby="play-first-visit-title">
      <h2 id="play-first-visit-title" className="sp-title-m">
        {FIRST_VISIT_TITLE}
      </h2>
      <ul className="play-first-visit-picks">
        {JUDGE_PICKS.map((pick) => (
          <li key={pick.id}>
            <Chip className="play-first-visit-pick" data-testid={`play-pick-${pick.id}`} disabled={disabled} onClick={() => onPick(pick.sentence)}>
              {pick.sentence}
            </Chip>
          </li>
        ))}
      </ul>
      <div className="play-first-visit-actions">
        <Button variant="secondary" size="s" data-testid="play-try-own" disabled={disabled} onClick={onTryOwn}>
          {TRY_YOUR_OWN}
        </Button>
        <Button variant="link" size="s" data-testid="play-first-visit-close" onClick={onClose}>
          {NOT_NOW}
        </Button>
      </div>
    </section>
  );
}
