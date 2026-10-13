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
 *
 * Akce hrdiny (P46A T7, `AbilityButton`) berou J a K pro sebe: ve hře s nimi
 * J ani K nestřílí, neudeří ani nepoužijí – stisknou akci A a B.
 */

import { type CSSProperties, useEffect, useRef } from 'react';

import { ABILITY_BUTTONS, type AbilityControl } from '@/play/arcade/abilities/state';
import { baseControlOf, underlyingRule } from '@/play/arcade/addons';
import { type AbilityId, type ArcadeWorld, BUTTON, nativeRule } from '@/play/arcade/contract';
import { FIGHT_RULES } from '@/play/arcade/pieces/fight';

import { Icon, type IconName } from '../ui/icons';
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
  const uses = nativeRule(rules, 'interact') !== undefined;
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

/** Akce hrdiny (P46A T7): popisek a ikona. Klávesa podle pořadí ve `spec.abilities`: A = J, B = K. */
const ABILITY_FACES: Readonly<Record<AbilityId, { readonly label: string; readonly icon: IconName }>> = {
  shoot: { label: 'Shoot', icon: 'shoot' },
  strike: { label: 'Strike', icon: 'strike' },
  dash: { label: 'Dash', icon: 'dash' },
  shield: { label: 'Shield', icon: 'shield' },
  grab: { label: 'Grab', icon: 'grab' },
};
const ABILITY_KEYS = ['j', 'k'] as const;

/** Akce hrdiny světa v pořadí tlačítek A, B; hra bez nich (a každá stará hra) vrátí prázdný seznam. */
export function abilitiesOf(world: ArcadeWorld): readonly AbilityId[] {
  if (world.control.id !== 'addon_control') return [];
  return (world.control.params as { readonly abilities?: AbilityControl }).abilities?.ids ?? [];
}

/** J a K stisknou akci A a B (stisk, ne držení – střelba i úder jdou na nový stisk). */
export function useAbilityInput(session: ArcadeSession, abilities: readonly AbilityId[], active: boolean): void {
  useEffect(() => {
    if (!active || abilities.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const slot = (ABILITY_KEYS as readonly string[]).indexOf(event.key.toLowerCase());
      if (slot < 0 || slot >= abilities.length) return;
      event.preventDefault();
      if (!event.repeat) session.press(ABILITY_BUTTONS[slot] as number);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [session, abilities, active]);
}

/**
 * Tlačítko akce `slot` (0 = A, 1 = B) s ikonou a popiskem. `stack` = kolikáté kolo
 * odspodu ve sloupci vpravo dole (střelba a úder/použití leží pod ním).
 */
export function AbilityButton({ session, ability, slot, stack }: { readonly session: ArcadeSession; readonly ability: AbilityId; readonly slot: number; readonly stack: number }) {
  const button = useRef<HTMLButtonElement | null>(null);
  const { label, icon } = ABILITY_FACES[ability];
  const bit = ABILITY_BUTTONS[slot] as number;
  // Ťuk nesmí doběhnout k ploše scény (tam je skok nebo tah), jako u střelby.
  useEffect(() => {
    const element = button.current;
    if (element === null) return;
    const stop = (event: PointerEvent) => event.stopPropagation();
    const down = (event: PointerEvent) => {
      stop(event);
      session.press(bit);
    };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointerup', stop);
    return () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointerup', stop);
    };
  }, [session, bit]);
  const key = ABILITY_KEYS[slot] as string;
  return (
    <button
      ref={button}
      type="button"
      className="play-fire play-ability"
      data-testid={`arcade-ability-${ability}`}
      data-slot={slot === 0 ? 'a' : 'b'}
      aria-keyshortcuts={key.toUpperCase()}
      style={{ '--_slot': stack } as CSSProperties}
    >
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}
