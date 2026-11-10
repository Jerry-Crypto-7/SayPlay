/**
 * Dotykové adaptéry her se vstupem `genre` (P68 T1, `P68_INPUT` v `genre/p68-contract.ts`). Plátno (`ArcadeStage`)
 * vykreslí adaptér hry podle id ovládání; adaptér dostane jen relaci a volá jen `session.press` / `session.hold`,
 * takže tvar záznamu, Dare ani serverový replay se nemění. Líně načtený – kód adaptéru jde jen do hry, která ho má.
 *
 * Registraci píše jen P68-I; komponentu `genres/<id>/<Id>Touch.tsx` kategorie.
 */

import { type ComponentType, lazy } from 'react';

import type { ArcadeSession } from '../session';

export interface GenreTouchProps {
  readonly session: ArcadeSession;
}

export const GENRE_TOUCH: Readonly<Record<string, ComponentType<GenreTouchProps>>> = {
  railfps: lazy(() => import('./railfps/RailfpsTouch').then((module) => ({ default: module.RailfpsTouch }))),
  drawsave: lazy(() => import('./drawsave/DrawsaveTouch').then((module) => ({ default: module.DrawsaveTouch }))),
  orrery: lazy(() => import('./orrery/OrreryTouch').then((module) => ({ default: module.OrreryTouch }))),
  shop: lazy(() => import('./shop/ShopTouch').then((module) => ({ default: module.ShopTouch }))),
};
