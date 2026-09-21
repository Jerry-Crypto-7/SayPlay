/**
 * Ovládání „klepni na cíl“ (P23-C T5) – čistá logika bez Reactu.
 *
 * Karta je jeden cíl, na který runtime dovoluje hráči jednat: akce z
 * `controller.actions` se seskupí podle `target`, popisek se vezme z objektu
 * blueprintu (`label`), jinak zůstane id. První klepnutí je vždycky `moveTo`;
 * druhé klepnutí na tutéž kartu je `pickup`, nebo `use`, když to svět pro ten
 * cíl deklaruje – a nic, když ne. Runtime rozhoduje, co se doopravdy stane
 * (vzdálenost, zámky); tady se jen vybírá, co poslat.
 *
 * Klávesy 1–9/mezerník/E jdou přes `intentFromKey` z `src/game/flow.ts`,
 * aby klávesnice a karty měly jeden slovník záměrů.
 */

import { intentFromKey } from '@/game/flow';
import type { RuntimeAction } from '@/worldstream/runtime-input';

export interface TargetCard {
  readonly id: string;
  readonly label: string;
  readonly moveTo: RuntimeAction;
  /** Druhé klepnutí; `null` = karta hlásí jen „Move here“. */
  readonly second: RuntimeAction | null;
}

interface LabelledObject {
  readonly stableId: string;
  readonly label: string;
  readonly binding?: { readonly entityId?: string };
}

/** Kdo hraje: aktér prvního `moveTo` – svědek i hráč jsou táž entita. */
export function playerActor(actions: readonly RuntimeAction[]): string | null {
  return actions.find((action) => action.actionId === 'moveTo')?.actor ?? null;
}

export function targetCards(actions: readonly RuntimeAction[], objects: readonly LabelledObject[]): readonly TargetCard[] {
  const actor = playerActor(actions);
  if (actor === null) return [];
  const byTarget = new Map<string, RuntimeAction[]>();
  for (const action of actions) {
    if (action.actor !== actor || action.target === undefined || action.target === actor) continue;
    const list = byTarget.get(action.target) ?? [];
    list.push(action);
    byTarget.set(action.target, list);
  }
  const cards: TargetCard[] = [];
  for (const [target, list] of byTarget) {
    const moveTo = list.find((action) => action.actionId === 'moveTo');
    if (moveTo === undefined) continue;
    const second = list.find((action) => action.actionId === 'pickup') ?? list.find((action) => action.actionId === 'use') ?? null;
    cards.push({ id: target, label: labelOf(target, objects), moveTo, second });
  }
  return cards;
}

function labelOf(target: string, objects: readonly LabelledObject[]): string {
  const object = objects.find((entry) => entry.binding?.entityId === target) ?? objects.find((entry) => entry.stableId === target);
  return object?.label ?? target;
}

/** Slovo na kartě pro druhé klepnutí. */
export function secondTapLabel(card: TargetCard): string {
  if (card.second === null) return 'Move here';
  return card.second.actionId === 'pickup' ? 'Pick up' : 'Use';
}

/**
 * Co poslat po klepnutí na kartu. Vybraná karta klepnutá podruhé pošle druhou
 * akci (když je); jinak je klepnutí `moveTo` a karta se stává vybranou.
 */
export function tapAction(card: TargetCard, selected: string | null): { readonly action: RuntimeAction | null; readonly selected: string } {
  if (selected === card.id) return { action: card.second, selected: card.id };
  return { action: card.moveTo, selected: card.id };
}

/** Klávesa → akce nad kartami; `null`, když klávesa nic neznamená nebo svět tu akci nenabízí. */
export function keyAction(key: string, cards: readonly TargetCard[], selected: string | null): { readonly action: RuntimeAction; readonly selected: string } | null {
  const intent = intentFromKey(key, cards.map((card) => card.id), selected);
  if (intent === null) return null;
  const card = cards.find((entry) => entry.id === intent.target);
  if (card === undefined) return null;
  if (intent.actionId === 'moveTo') return { action: card.moveTo, selected: card.id };
  if (card.second === null || card.second.actionId !== intent.actionId) return null;
  return { action: card.second, selected: card.id };
}
