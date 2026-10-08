'use client';

/**
 * Úder a použití (P32-0 T5): vstupní bity `BUTTON.ATTACK` a `BUTTON.INTERACT`
 * z T4. Klávesa J udeří, K se drží („Use“ drží cíl, dokud stav nedojde);
 * na dotyku tlačítko nad střelbou. Jen ve světě, který akci čte – souboj
 * (ovládání `fight` nebo jeho pravidla) a pravidlo `interact` – jinak by
 * stisk jen přibyl do záznamu. Souboj (P32E) ani úkol (P32G) vstup nepíšou.
 *
 * J je i klávesa střelby doplňku `+shoot` (`FIRE_KEYS` v `ArcadeStage.tsx`):
 * svět se soubojem i střelbou by na J dostal oba bity naráz.
 */

import { useEffect, useRef } from 'react';

import { baseControlOf, underlyingRule } from '@/play/arcade/addons';
import { type ArcadeWorld, BUTTON } from '@/play/arcade/contract';
import { FIGHT_RULES } from '@/play/arcade/pieces/fight';

import { isTyping } from './input';
import type { ArcadeSession } from './session';

export type ArcadeAction = 'attack' | 'use';

/** Bit, klávesa, popisek a zda se drží (jako `HOLD`), nebo jen stiskne. */
const ACTIONS: Readonly<Record<ArcadeAction, { readonly bit: number; readonly key: string; readonly label: string; readonly held: boolean }>> = {
  attack: { bit: BUTTON.ATTACK, key: 'j', label: 'Attack', held: false },
  use: { bit: BUTTON.INTERACT, key: 'k', label: 'Use', held: true },
};

/** Akce, které svět čte: úder v souboji, použití s pravidlem `interact`. */
export function actionsOf(world: ArcadeWorld): readonly ArcadeAction[] {
  const rules = world.rules.map(underlyingRule);
  const attached = rules.filter(rule => rule.id === 'assembly_part').map(rule => (rule.params.part as { kind: string }).kind);
  const fights = baseControlOf(world.control).id === 'fight' || rules.some((rule) => Object.hasOwn(FIGHT_RULES, rule.id)) || attached.some(kind => kind === 'fight' || kind === 'duel');
  const uses = rules.some((rule) => rule.id === 'interact');
  return [...(fights ? (['attack'] as const) : []), ...(uses ? (['use'] as const) : [])];
}

/**
 * J = úder (hned při stisku), K = použití, drží se do puštění. Použití drží
 * `holdButtons` – jediné držené tlačítko světa s pravidlem `interact`.
 */
export function useActionInput(session: ArcadeSession, actions: readonly ArcadeAction[], active: boolean): void {
  useEffect(() => {
    if (!active || actions.length === 0) return;
    const byKey = new Map(actions.map((action) => [ACTIONS[action].key, ACTIONS[action]]));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const action = byKey.get(event.key.toLowerCase());
      if (action === undefined) return;
      event.preventDefault();
      if (event.repeat) return;
      if (action.held) session.holdButtons(action.bit);
      else session.press(action.bit);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (byKey.get(event.key.toLowerCase())?.held === true) session.holdButtons(0);
    };
    const release = (): void => session.holdButtons(0);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
    };
  }, [session, actions, active]);
}

export function ActionButton({ session, action }: { readonly session: ArcadeSession; readonly action: ArcadeAction }) {
  const button = useRef<HTMLButtonElement | null>(null);
  const { bit, label, held } = ACTIONS[action];
  // Ťuk na tlačítko nesmí doběhnout k ploše scény – tam je to skok. Plocha poslouchá
  // nativně, takže zastavit to musí nativní posluchač (jako tlačítko střelby).
  useEffect(() => {
    const element = button.current;
    if (element === null) return;
    const down = (event: PointerEvent) => {
      event.stopPropagation();
      if (held) {
        // Prst sjede z tlačítka a pustí jinde – puštění musí přijít sem.
        element.setPointerCapture(event.pointerId);
        session.holdButtons(bit);
      } else session.press(bit);
    };
    const up = (event: PointerEvent) => {
      event.stopPropagation();
      if (held) session.holdButtons(0);
    };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    return () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
    };
  }, [session, bit, held]);
  return (
    <button ref={button} type="button" className="play-fire play-action" data-testid={`arcade-${action}`}>
      {label}
    </button>
  );
}
