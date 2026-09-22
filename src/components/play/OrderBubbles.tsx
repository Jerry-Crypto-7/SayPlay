'use client';

/**
 * Bubliny přání nad zákazníky (P25E T4). Nález P25B: hráč nevěděl, co kdo
 * chce – jen z popisu cíle. Každý neobsloužený zákazník nese bublinu s názvem
 * jídla (`readOrders`); po obsloužení zmizí.
 *
 * Bublina je sprite s texturou z 2D plátna – knihovnu na HTML ve scéně
 * projekt nemá a kvůli jednomu popisku ji nepřidává. Kreslí se uvnitř
 * `<Canvas>`; sonda `window.__playOrders` říká e2e, kolik bublin visí.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { CanvasTexture, SRGBColorSpace } from 'three';

import { cellToWorld } from '@/components/viewer/projection';
import type { GameSpecV1 } from '@/play/spec';
import type { RuntimeController } from '@/worldstream/runtime-controller';

import { openOrders, readOrders } from './orders';
import { gridOf } from './sight';

declare global {
  interface Window {
    __playOrders?: () => { readonly orders: number; readonly open: number };
  }
}

const HEIGHT = 1.3;
const TEXT_PX = 44;

/** Barvy z palety `/play` (`play.css`): panel, jantar, text. */
function bubbleTexture(label: string): { texture: CanvasTexture; aspect: number } {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.font = `600 ${TEXT_PX}px system-ui, sans-serif`;
  const width = Math.ceil(context.measureText(label).width) + 56;
  const height = TEXT_PX + 40;
  canvas.width = width;
  canvas.height = height;
  context.fillStyle = '#1e293b';
  context.strokeStyle = '#f59e0b';
  context.lineWidth = 6;
  context.beginPath();
  context.roundRect(3, 3, width - 6, height - 6, (height - 6) / 2);
  context.fill();
  context.stroke();
  context.font = `600 ${TEXT_PX}px system-ui, sans-serif`;
  context.fillStyle = '#f1f5f9';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, width / 2, height / 2 + 2);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return { texture, aspect: width / height };
}

interface Sim {
  readonly rules: unknown;
  readonly layout: unknown;
}

export function OrderBubbles({ sim, roles, controller }: { readonly sim: Sim; readonly roles: GameSpecV1['roles']; readonly controller: RuntimeController }) {
  const orders = useMemo(() => readOrders(sim, roles), [sim, roles]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const open = openOrders(orders, snapshot);
  const grid = useMemo(() => gridOf(sim), [sim]);

  const textures = useMemo(() => new Map(orders.map((order) => [order.label, bubbleTexture(order.label)])), [orders]);
  useEffect(() => () => textures.forEach(({ texture }) => texture.dispose()), [textures]);

  useEffect(() => {
    const probe = () => ({ orders: orders.length, open: open.length });
    window.__playOrders = probe;
    return () => {
      if (window.__playOrders === probe) delete window.__playOrders;
    };
  }, [orders.length, open.length]);

  if (open.length === 0) return null;
  return (
    <group name="order-bubbles">
      {open.map((order) => {
        const customer = snapshot.entities.find((entity) => entity.stableId === order.customer);
        const bubble = textures.get(order.label);
        if (customer === undefined || bubble === undefined) return null;
        const at = cellToWorld([customer.x, customer.y], grid, HEIGHT);
        return (
          <sprite key={order.customer} position={[at.x, at.y, at.z]} scale={[0.5 * bubble.aspect, 0.5, 1]} renderOrder={10}>
            <spriteMaterial map={bubble.texture} transparent depthTest={false} />
          </sprite>
        );
      })}
    </group>
  );
}
