/**
 * Řádek se slovesem na plátně (P43 T7): „Shoot the goblins!“ nad scénou první
 * tři vteřiny hry. Štítek kitu `sp-world-tag` ve slunečné variantě – rajčatová
 * zůstává jediné akci obrazovky. Klip porotce HTML skrývá, řádek je pro lidi.
 */

export function VerbLine({ line }: { readonly line: string }) {
  return (
    <p className="sp-world-tag sp-world-tag--goal play-verb-line" data-testid="play-verb-line" aria-hidden="true">
      {line}
    </p>
  );
}
