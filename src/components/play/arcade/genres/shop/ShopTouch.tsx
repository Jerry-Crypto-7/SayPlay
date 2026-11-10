'use client';

/**
 * Dotykový adaptér obchodu se součtem (P83E T3, vstup `genre`): cenovky věcí v DOM a ťuk na věc.
 *
 * - **Cenovky:** jedna na věc police, čitelná i na 390×844; polohu a stav jí každý snímek dává `ShopScene` přes
 *   `data-shop-spots` plochy (bod nad věcí ve zlomku plátna, stav `SHOP_STATE`). Cenovka nese `data-value` (jednotky
 *   hry) a `data-state` – e2e z nich sečte věci na pultu a porovná se součtem v HUD.
 * - **Číslo do součtu:** když věc dopadne na pult, z jejího místa vyletí „+$1.50“ k počítadlu `hud-counter-total`.
 * - **Ťuk:** prst do 64 px od cenovky nebo věci pod ní na polici → `session.press(TAP, axisOfCell(slot))`. Šipky
 *   hýbou kurzorem, mezerník a Enter berou věc pod kurzorem (`keyButton` skákání + Enter).
 *
 * Jen přes relaci – tvar záznamu, Dare ani serverový replay se nemění. Plochu hry najde jako rodiče svého kotvicího
 * prvku (`ArcadeStage` ho kreslí přímo do `.play-stage`).
 */

import { type CSSProperties, useEffect, useMemo, useRef } from 'react';

import { borderWidth, color, radius } from '@/brand/tokens';
import { BUTTON, bodyHp } from '@/play/arcade/contract';
import { axisOfCell } from '@/play/arcade/pieces/lanes';
import { SHOP_STATE } from '@/play/arcade/pieces/shop-level';

import { isTyping } from '../../input';
import { keyButton } from '../hop/hop-input';
import type { GenreTouchProps } from '../touch-registry';
import { shopGameOf, tagText } from './shop-text';

/** Jak daleko od cenovky (nebo věci pod ní) prst věc ještě bere (px). */
const REACH_PX = 64;
/** Věc leží zhruba tolik pod svou cenovkou (px). */
const ITEM_BELOW_PX = 36;
const FLY_MS = 650;

const TAG: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  transform: 'translate(-50%, -100%)',
  padding: '2px 7px',
  background: color.paper,
  color: color.ink,
  border: `${borderWidth.thin}px solid ${color.ink}`,
  borderRadius: radius.xs,
  font: '800 15px/1.2 inherit',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  userSelect: 'none',
  visibility: 'hidden',
};

type Spot = readonly [number, number, number];

const spotsOf = (raw: string | undefined): Spot[] =>
  (raw ?? '')
    .split(';')
    .filter((part) => part !== '')
    .map((part) => part.split(',').map(Number) as unknown as Spot);

export function ShopTouch({ session }: GenreTouchProps) {
  const anchor = useRef<HTMLSpanElement | null>(null);
  const tags = useRef<(HTMLSpanElement | null)[]>([]);
  const game = useMemo(() => shopGameOf(session.world), [session]);
  const values = useMemo(() => {
    if (game === null) return [];
    const initial = Int32Array.from(session.world.initial);
    return Array.from({ length: game.count }, (_, slot) => bodyHp(initial, game.first + slot));
  }, [session, game]);

  useEffect(() => {
    const surface = anchor.current?.parentElement;
    if (surface == null || game === null) return;
    let frame = 0;
    let last = '';
    let before: number[] = [];

    const fly = (slot: number, x: number, y: number): void => {
      const box = surface.getBoundingClientRect();
      const label = document.createElement('span');
      label.textContent = `+${tagText(values[slot] as number, game.unit)}`;
      label.dataset.testid = 'shop-fly';
      Object.assign(label.style, TAG, { left: `${x * 100}%`, top: `${y * 100}%`, visibility: 'visible', background: color.sun, zIndex: '3' });
      surface.appendChild(label);
      const goal = document.querySelector('[data-testid="hud-counter-total"]')?.getBoundingClientRect();
      const dx = goal === undefined ? 0 : goal.left + goal.width / 2 - box.left - x * box.width;
      const dy = goal === undefined ? -y * box.height : goal.top + goal.height - box.top - y * box.height;
      const flight = label.animate(
        [
          { transform: 'translate(-50%, -100%) scale(1.15)', opacity: 1 },
          { transform: `translate(calc(-50% + ${dx.toFixed(0)}px), calc(-100% + ${dy.toFixed(0)}px)) scale(0.8)`, opacity: 0.3 },
        ],
        { duration: FLY_MS, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)' },
      );
      flight.onfinish = () => label.remove();
    };

    const paint = (): void => {
      frame = requestAnimationFrame(paint);
      const raw = surface.dataset.shopSpots ?? '';
      if (raw === last) return;
      last = raw;
      const spots = spotsOf(raw);
      spots.forEach(([x, y, state], slot) => {
        const tag = tags.current[slot];
        if (tag == null) return;
        tag.style.left = `${(x * 100).toFixed(2)}%`;
        tag.style.top = `${(y * 100).toFixed(2)}%`;
        tag.style.visibility = 'visible';
        tag.style.background = state === SHOP_STATE.placed ? color['mint-deep'] : color.paper;
        tag.style.transform = TAG.transform as string;
        tag.dataset.state = String(state);
        const was = before[slot];
        if (was !== undefined && was !== SHOP_STATE.placed && state === SHOP_STATE.placed) fly(slot, x, y);
      });
      before = spots.map((spot) => spot[2]);
      // Věci na pultu leží hustěji, než je cenovka široká (telefon): cenovky položených věcí jdou do řad nad sebou,
      // každá do nejnižší řady, kde nepřekryje souseda.
      const width = surface.clientWidth;
      const rows: number[] = [];
      spots
        .map((spot, slot) => ({ x: spot[0] * width, placed: spot[2] === SHOP_STATE.placed, tag: tags.current[slot] }))
        .filter((entry) => entry.placed && entry.tag != null)
        .sort((a, b) => a.x - b.x)
        .forEach(({ x, tag }) => {
          const half = tag!.offsetWidth / 2 + 2;
          let row = rows.findIndex((right) => right <= x - half);
          if (row < 0) row = rows.push(0) - 1;
          rows[row] = x + half;
          if (row > 0) tag!.style.transform = `translate(-50%, calc(${String(-100 * (row + 1))}% - ${String(row * 3)}px))`;
        });
    };
    frame = requestAnimationFrame(paint);

    const onDown = (event: PointerEvent): void => {
      if (event.button > 0) return;
      const box = surface.getBoundingClientRect();
      const px = event.clientX - box.left;
      const py = event.clientY - box.top;
      let best = -1;
      let nearest = REACH_PX;
      spotsOf(surface.dataset.shopSpots).forEach(([x, y, state], slot) => {
        if (state !== SHOP_STATE.shelf) return;
        const tx = x * box.width;
        const ty = y * box.height;
        const reach = Math.min(Math.hypot(px - tx, py - ty), Math.hypot(px - tx, py - ty - ITEM_BELOW_PX));
        if (reach < nearest) {
          nearest = reach;
          best = slot;
        }
      });
      if (best >= 0) session.press(BUTTON.TAP, axisOfCell(best));
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat || isTyping(event.target)) return;
      const button = event.key === 'Enter' ? BUTTON.TAP : keyButton(event.key);
      if (button === 0) return;
      event.preventDefault();
      session.press(button);
    };
    surface.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(frame);
      surface.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [session, game, values]);

  return (
    <>
      <span ref={anchor} hidden />
      {game === null
        ? null
        : values.map((value, slot) => (
            <span
              // Pořadí místa police je stálé po celou hru.
              // eslint-disable-next-line react/no-array-index-key
              key={slot}
              ref={(tag) => {
                tags.current[slot] = tag;
              }}
              style={TAG}
              data-testid="shop-tag"
              data-slot={slot}
              data-value={value}
              data-state={SHOP_STATE.shelf}
            >
              {tagText(value, game.unit)}
            </span>
          ))}
    </>
  );
}
