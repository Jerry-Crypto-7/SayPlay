/**
 * Popisek jména na plátně (P58A T5): „Cat“ nad hrdinou, pak „Crocodile“ nad nejbližším
 * tělem, které věta jmenuje – každé 1,5 s po řádku se slovesem, nikdy spolu. Štítek kitu
 * `sp-world-tag` ve slunečné variantě jako řádek se slovesem (rajčatová patří jediné akci
 * obrazovky); polohu (a jméno těla) mu každý snímek píše `NameAnchor` ve stage, do té doby
 * je schovaný. Klip porotce HTML skrývá, popisek je pro lidi.
 *
 * Na telefonu na výšku (P64 T6) visí štítek nad tělem u horní hrany přes horní pás HUD
 * (`NameAnchor` ho drží jen nad 12 % výšky, pás má 13–18 %). Po každém zápisu polohy se proto
 * změří spodní hrana horních kusů HUD a štítek se o chybějící kus posune dolů (`--_name-push`,
 * `play.css`). Mimo telefon na výšku se nic nečte ani nepíše; simulace a hash štítek nevidí.
 */

import { useEffect, useRef } from 'react';

import type { NameSlot } from './name-line';

/** Tentýž dotaz jako portrétní blok HUD v `play.css`. */
const PORTRAIT = '(max-aspect-ratio: 1/1) and (pointer: coarse) and (max-width: 1023px)';
/** Horní kusy HUD, jako `hudBars` v `ArcadeStage.tsx`. */
const TOP_HUD = '.play-hud-progress, .play-hud-corner, .play-hud-goal';
/** Mezera pod pásem (`--sp-space-2`). */
const GAP_PX = 8;

/** O kolik px štítek posunout dolů, aby jeho horní hrana stála pod horním pásem HUD. */
function namePush(anchorPx: number, tagHeight: number, hudBottomPx: number): number {
  return Math.max(0, Math.ceil(hudBottomPx + GAP_PX - (anchorPx - tagHeight)));
}

function keepUnderHud(tag: HTMLElement): void {
  let value = '';
  const stage = tag.offsetParent;
  if (tag.style.visibility === 'visible' && stage !== null && window.matchMedia(PORTRAIT).matches) {
    const box = stage.getBoundingClientRect();
    let hud = 0;
    for (const bar of tag.closest('.play-shell')?.querySelectorAll<HTMLElement>(TOP_HUD) ?? []) {
      const rect = bar.getBoundingClientRect();
      if (rect.height > 0 && getComputedStyle(bar).visibility !== 'hidden') hud = Math.max(hud, rect.bottom - box.top);
    }
    // `NameAnchor` píše `top` v % výšky stage; štítek visí nad tím bodem (`translate(-50%, -100%)` kitu).
    const push = namePush((parseFloat(tag.style.top) / 100) * box.height, tag.offsetHeight, hud);
    if (push > 0) value = `${String(push)}px`;
  }
  // Tatáž hodnota se nepíše: zápis by znovu spustil pozorovatele.
  if (tag.style.getPropertyValue('--_name-push') !== value) {
    if (value === '') tag.style.removeProperty('--_name-push');
    else tag.style.setProperty('--_name-push', value);
  }
}

export function NameLine({ slot, hero }: { readonly slot: NameSlot; readonly hero: string | null }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const tag = ref.current;
    if (tag === null) return;
    const watch = new MutationObserver(() => keepUnderHud(tag));
    watch.observe(tag, { attributes: true, attributeFilter: ['style'] });
    return () => watch.disconnect();
  }, []);
  return (
    <p ref={ref} className="sp-world-tag sp-world-tag--goal play-name-line" data-testid="play-name-line" data-slot={slot} aria-hidden="true">
      {slot === 'hero' ? hero : null}
    </p>
  );
}
