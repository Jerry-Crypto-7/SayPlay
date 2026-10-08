/**
 * Proužek výzvy nad hrou (P44B T8): kamarád otevřel odkaz `?dare=` a hned vidí, kdo ho vyzývá
 * a co má porazit – „Ada dares you: beat 2,450“, výzva bez identity „A friend dares you“. Cíl
 * dává `dareGoal`, týž jako HUD v `ArcadePlay`. Bez tlačítka: rajčatová akce patří hře.
 */

import { ARCADE_HZ, type ArcadeWorld } from '@/play/arcade/contract';

import { type Dare, dareGoal } from './best';
import { daresYou } from './starters';

export function DareStrip({ challenge, arcade }: { readonly challenge: Dare; readonly arcade: ArcadeWorld }) {
  // Týž příznak přežití jako `ArcadePlay` (`survive`), ať proužek a HUD čtou stejný cíl.
  const goal = dareGoal(challenge, ARCADE_HZ, arcade.rules.some((rule) => rule.id === 'survive_time')).text;
  return (
    <aside className="play-dare-strip" data-testid="play-dare-strip" role="status">
      <p className="play-dare-strip-text">
        <strong>{daresYou(challenge.by ?? 'A friend')}</strong>
        {`: ${goal.charAt(0).toLowerCase()}${goal.slice(1)}`}
      </p>
    </aside>
  );
}
