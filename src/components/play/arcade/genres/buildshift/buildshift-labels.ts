/**
 * Popisky scény směny se stavbou obchodu ve 3D (P68-S T5, T10): plátno → textura, překreslí se jen při změně klíče.
 * Text se kreslí do textur, ne do DOM HUD – popisky „Served“, „Coins“ ani „Rush!“ nejsou v `HUD_COUNTER_LABELS`
 * (požadavek v `evals/play/p68/stavba/integration.md`). Jen barvy kitu, karta plná a s inkoustovým okrajem.
 */

import { CanvasTexture, MeshBasicMaterial, SRGBColorSpace } from 'three';

import { color } from '@/brand/tokens';

const LABEL_PX = 256;
const FONT = 'Roboto, system-ui, sans-serif';

export interface Label {
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  readonly material: MeshBasicMaterial;
  key: string;
}

export function createLabel(): Label {
  const canvas = document.createElement('canvas');
  canvas.width = LABEL_PX;
  canvas.height = LABEL_PX;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return { canvas, texture, material: new MeshBasicMaterial({ map: texture, toneMapped: false }), key: '' };
}

export function disposeLabel(label: Label): void {
  label.texture.dispose();
  label.material.dispose();
}

export function paint(label: Label, key: string, draw: (context: CanvasRenderingContext2D) => void): void {
  if (label.key === key) return;
  const context = label.canvas.getContext('2d');
  if (context === null) return;
  label.key = key;
  context.clearRect(0, 0, LABEL_PX, LABEL_PX);
  draw(context);
  label.texture.needsUpdate = true;
}

/** Karta kitu: plná barva, inkoustový okraj, zaoblené rohy (žádná průhlednost). */
export function card(context: CanvasRenderingContext2D, fill: string, border: number): void {
  context.fillStyle = fill;
  context.strokeStyle = color.ink;
  context.lineWidth = border;
  context.beginPath();
  context.roundRect(border / 2 + 2, border / 2 + 2, LABEL_PX - border - 4, LABEL_PX - border - 4, 28);
  context.fill();
  context.stroke();
}

export function words(context: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, weight: number, fill: string): void {
  context.font = `${weight} ${px}px ${FONT}`;
  context.fillStyle = fill;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, x, y);
}

/** Mince: slunečný kotouč s inkoustovým okrajem, uvnitř cena. */
export function coin(context: CanvasRenderingContext2D, x: number, y: number, r: number, value: string): void {
  context.fillStyle = color.sun;
  context.strokeStyle = color.ink;
  context.lineWidth = 6;
  context.beginPath();
  context.arc(x, y, r, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  if (value !== '') words(context, value, x, y + 2, r * 1.25, 900, color.ink);
}
