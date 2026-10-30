/**
 * Popisek jména na plátně (P58A T5): „Cat“ nad hrdinou, pak „Crocodile“ nad nejbližším
 * tělem, které věta jmenuje – každé 1,5 s po řádku se slovesem, nikdy spolu. Štítek kitu
 * `sp-world-tag` ve slunečné variantě jako řádek se slovesem (rajčatová patří jediné akci
 * obrazovky); polohu (a jméno těla) mu každý snímek píše `NameAnchor` ve stage, do té doby
 * je schovaný. Klip porotce HTML skrývá, popisek je pro lidi.
 *
 * Na telefonu na výšku (P64 T6) visí štítek nad tělem u horní hrany přes horní pás HUD
 * (`NameAnchor` ho drží jen nad 12 % výšky, pás má 13–18 %). Po každém snímku proto
 * `keepClear` změří spodní hranu horních kusů HUD a štítek se o chybějící kus posune dolů
 * (`--_name-push`, `play.css`). Souboj na výšku (P64 T8-R1) se dívá za rytířem ze tří čtvrtin:
 * bližší rytíř sahá na obrazovce skoro tak vysoko jako hlava hydry a jeho štítek padl pod povel
 * „Strike!“ nad ní. Štítek proto ustoupí i z povelu – do strany (`--_name-shift`) nebo pod něj,
 * o kratší kus. Mimo telefon na výšku se nic nečte ani nepíše; simulace a hash štítek nevidí.
 */

import type { NameSlot } from './name-line';

/** Tentýž dotaz jako portrétní blok HUD v `play.css`. */
const PORTRAIT = '(max-aspect-ratio: 1/1) and (pointer: coarse) and (max-width: 1023px)';
/** Horní kusy HUD, jako `hudBars` v `ArcadeStage.tsx`. */
const TOP_HUD = '.play-hud-progress, .play-hud-corner, .play-hud-goal';
/** Povel souboje nad soupeřem (`DuelScene.tsx`). */
const CUE = '[data-testid="duel-cue"]';
/** Mezera pod pásem a kolem povelu (`--sp-space-2`). */
const GAP_PX = 8;

/** O kolik px štítek posunout dolů, aby jeho horní hrana stála pod horním pásem HUD. */
function namePush(anchorPx: number, tagHeight: number, hudBottomPx: number): number {
  return Math.max(0, Math.ceil(hudBottomPx + GAP_PX - (anchorPx - tagHeight)));
}

type Span = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

/**
 * Nejkratší úkrok štítku z povelu: vlevo, vpravo (jen uvnitř plochy) nebo dolů pod povel. Štítek, který povel
 * nezakrývá ani s mezerou, zůstane, kde je.
 */
function clearOf(tag: Span, cue: Span, width: number): { readonly x: number; readonly y: number } {
  if (tag.left >= cue.right + GAP_PX || tag.right <= cue.left - GAP_PX || tag.top >= cue.bottom + GAP_PX || tag.bottom <= cue.top - GAP_PX) return { x: 0, y: 0 };
  const moves = [
    { x: Math.floor(cue.left - GAP_PX - tag.right), y: 0 },
    { x: Math.ceil(cue.right + GAP_PX - tag.left), y: 0 },
  ].filter((move) => tag.left + move.x >= 0 && tag.right + move.x <= width);
  moves.push({ x: 0, y: Math.ceil(cue.bottom + GAP_PX - tag.top) });
  return moves.reduce((best, move) => (Math.abs(move.x) + move.y < Math.abs(best.x) + best.y ? move : best));
}

function write(tag: HTMLElement, name: string, px: number): void {
  const value = px === 0 ? '' : `${String(px)}px`;
  // Tatáž hodnota se nepíše: každý zápis stylu znovu přepočítá vrstvu štítku.
  if (tag.style.getPropertyValue(name) === value) return;
  if (value === '') tag.style.removeProperty(name);
  else tag.style.setProperty(name, value);
}

/** Volá `NameAnchor` po každém nakresleném snímku s viditelným štítkem (`addAfterEffect`, až po scénách). */
export function keepClear(tag: HTMLElement): void {
  let push = 0;
  let shift = 0;
  const stage = tag.offsetParent;
  const shell = tag.closest('.play-shell');
  if (tag.style.visibility === 'visible' && stage !== null && shell !== null && window.matchMedia(PORTRAIT).matches) {
    const box = stage.getBoundingClientRect();
    let hud = 0;
    for (const bar of shell.querySelectorAll<HTMLElement>(TOP_HUD)) {
      const rect = bar.getBoundingClientRect();
      if (rect.height > 0 && getComputedStyle(bar).visibility !== 'hidden') hud = Math.max(hud, rect.bottom - box.top);
    }
    // `NameAnchor` píše `left` a `top` v % stage; štítek visí nad tím bodem (`translate(-50%, -100%)` kitu).
    const anchorX = (parseFloat(tag.style.left) / 100) * box.width;
    const anchorY = (parseFloat(tag.style.top) / 100) * box.height;
    push = namePush(anchorY, tag.offsetHeight, hud);
    const cue = shell.querySelector<HTMLElement>(CUE);
    if (cue !== null && cue.style.visibility === 'visible') {
      const at = cue.getBoundingClientRect();
      const half = tag.offsetWidth / 2;
      const move = clearOf(
        { left: anchorX - half, right: anchorX + half, top: anchorY - tag.offsetHeight + push, bottom: anchorY + push },
        { left: at.left - box.left, right: at.right - box.left, top: at.top - box.top, bottom: at.bottom - box.top },
        box.width,
      );
      shift = move.x;
      push += move.y;
    }
  }
  write(tag, '--_name-push', push);
  write(tag, '--_name-shift', shift);
}

export function NameLine({ slot, hero }: { readonly slot: NameSlot; readonly hero: string | null }) {
  return (
    <p className="sp-world-tag sp-world-tag--goal play-name-line" data-testid="play-name-line" data-slot={slot} aria-hidden="true">
      {slot === 'hero' ? hero : null}
    </p>
  );
}
