'use client';

/**
 * Výzva prvních sekund (P28C T5). Mimo `Hud.tsx` schválně (P28E-R2): HUD
 * mřížky táhne runtime a jeho Zod schémata, a arkáda, která potřebuje jen
 * tuhle výzvu, by je jinak vyhodnocovala při každém startu.
 */

import { useEffect, useState } from 'react';

/** Náhradní vstupy za „nebo“ – výzva jmenuje jen první („Tap or Space“ → „Tap“). */
const ALTERNATIVE_INPUT = /\s+or\s+(?:space|arrows|a\/d|w\/s|down|up|enter|keys|tap|swipe|click|drag)\b/gi;

/**
 * Nápověda ovládání zkrácená na jeden povel – první věta, první souvětí, bez
 * náhradních kláves. U „Tap a mushroom to walk to it“ zůstane jen to, na co
 * klepnout („Tap a mushroom“). Žádný nový text: jen slova, která hra už
 * v nápovědě má.
 */
export function callToAction(controlsHint: string): string {
  const sentence = controlsHint.trim().split(/(?<=[.!?])\s/)[0] ?? '';
  let clause = (sentence.split(/[,;]/)[0] ?? '').replace(/[.!?]+$/, '').replace(ALTERNATIVE_INPUT, '').trim();
  // Povel s předmětem („Tap a/the …“) končí předmětem: „to walk to it“, „when the lava is calm“ je už návod.
  if (/^\w+\s+(?:a|an|the)\s/i.test(clause)) clause = clause.split(/\s+(?:to|when|and)\s+/i)[0] ?? clause;
  return clause;
}

const FIRST_PROMPT_MS = 4000;

/**
 * Velká výzva uprostřed: zmizí po prvním vstupu hráče – klepnutí, klávesa
 * mimo pole formuláře – nebo po 4 s. Menší nápověda v HUD zůstává.
 */
export function FirstPrompt({ controlsHint }: { readonly controlsHint: string }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const hide = (): void => setShown(false);
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null)) return;
      hide();
    };
    const timer = window.setTimeout(hide, FIRST_PROMPT_MS);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  const text = callToAction(controlsHint);
  if (!shown || text === '') return null;
  return (
    <p className="play-first-prompt" data-testid="play-first-prompt" aria-hidden="true">
      {text}
    </p>
  );
}
