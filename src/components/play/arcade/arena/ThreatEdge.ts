'use client';

/**
 * Šipka k hrozbě mimo záběr (P35 T2). Kamera arény drží hrdinu velkého
 * (`HERO_SHARE` v `ArenaScene.tsx`), takže pronásledovatel za zády se do
 * obrazu často nevejde; místo oddálení kamery ukáže kolečko na okraji plátna,
 * odkud jde. Strana jde do `data-threat-edge` (sonda e2e), prázdná = hrozba
 * v záběru nebo žádná. Jen kresba – jádro ani hash o ní nevědí.
 */

import { type RefObject, useEffect, useRef } from 'react';
import { type Camera, Vector3 } from 'three';

/** Kolečko stojí tak daleko od středu (NDC), ať se celé vejde do obrazu i na telefonu. */
const EDGE_INSET = 0.86;

export type EdgeSide = 'left' | 'right' | 'top' | 'bottom' | '';

/** Strana okraje a bod na něm (NDC) pro hrozbu promítnutou do `ndc`; v záběru `null`. */
export function edgeOf(ndc: { readonly x: number; readonly y: number; readonly z: number }): { readonly side: Exclude<EdgeSide, ''>; readonly x: number; readonly y: number } | null {
  // Za kamerou promítnutí převrací směr.
  const flip = ndc.z > 1 ? -1 : 1;
  const x = ndc.x * flip;
  const y = ndc.y * flip;
  if (flip === 1 && Math.abs(x) <= 1 && Math.abs(y) <= 1) return null;
  const far = Math.max(Math.abs(x), Math.abs(y), 1e-6);
  const side = Math.abs(x) >= Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'top' : 'bottom';
  return { side, x: (x / far) * EDGE_INSET, y: (y / far) * EDGE_INSET };
}

/** Kolečko na plátně; vrací funkci, která ho každý snímek postaví k hrozbě (`null` = schovat). */
export function useThreatEdge(surface: RefObject<HTMLDivElement | null>): (at: Vector3 | null, camera: Camera) => void {
  const marker = useRef<HTMLDivElement | null>(null);
  const shown = useRef<EdgeSide>('');
  const ndc = useRef(new Vector3());

  useEffect(() => {
    const host = surface.current;
    if (host === null) return;
    const element = document.createElement('div');
    element.className = 'play-threat-edge';
    element.setAttribute('aria-hidden', 'true');
    element.hidden = true;
    host.append(element);
    marker.current = element;
    return () => {
      element.remove();
      marker.current = null;
      delete host.dataset.threatEdge;
    };
  }, [surface]);

  return (at, camera) => {
    const element = marker.current;
    if (element === null) return;
    const edge = at === null ? null : edgeOf(ndc.current.copy(at).project(camera));
    if (edge !== null) {
      element.style.left = `${((edge.x + 1) / 2) * 100}%`;
      element.style.top = `${((1 - edge.y) / 2) * 100}%`;
    }
    const side: EdgeSide = edge?.side ?? '';
    if (side === shown.current) return;
    shown.current = side;
    element.hidden = side === '';
    element.dataset.side = side;
    if (surface.current !== null) surface.current.dataset.threatEdge = side;
  };
}
