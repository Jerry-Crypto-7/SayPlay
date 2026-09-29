/**
 * Výzva na startu (P28C T5, P33 T11). Mimo `Hud.tsx` ze stejného důvodu jako
 * `timer.ts` (P28E-R2): HUD mřížky táhne runtime a arkáda ho nepotřebuje.
 */

/** Klávesy, které nápověda nabízí vedle dotyku („Tap or Space …“). */
const KEY_WORD = 'space|arrows|a\\/d|w\\/s|down|up|enter|keys';

/** Náhradní vstupy za „nebo“ – výzva jmenuje jen první („Tap or Space“ → „Tap“). */
const ALTERNATIVE_INPUT = new RegExp(`\\s+or\\s+(?:${KEY_WORD}|tap|swipe|click|drag)\\b`, 'gi');

/** První věta a její první souvětí – to, co hráč udělá jako první. */
const firstClause = (controlsHint: string): string => {
  const sentence = controlsHint.trim().split(/(?<=[.!?])\s/)[0] ?? '';
  return (sentence.split(/[,;]/)[0] ?? '').replace(/[.!?]+$/, '');
};

/**
 * Nápověda ovládání zkrácená na jeden povel – první věta, první souvětí, bez
 * náhradních kláves. U „Tap a mushroom to walk to it“ zůstane jen to, na co
 * klepnout („Tap a mushroom“). Žádný nový text: jen slova, která hra už
 * v nápovědě má.
 */
export function callToAction(controlsHint: string): string {
  let clause = firstClause(controlsHint).replace(ALTERNATIVE_INPUT, '').trim();
  // Povel s předmětem („Tap a/the …“) končí předmětem: „to walk to it“, „when the lava is calm“ je už návod.
  if (/^\w+\s+(?:a|an|the)\s/i.test(clause)) clause = clause.split(/\s+(?:to|when|and)\s+/i)[0] ?? clause;
  return clause;
}

/** Klávesa prvního povelu pro desktop („Tap or Space to jump“ → „or press Space“); `null`, když ji nápověda nemá. */
export function desktopKeys(controlsHint: string): string | null {
  const key = new RegExp(`\\sor\\s+(${KEY_WORD})\\b`, 'i').exec(firstClause(controlsHint))?.[1];
  if (key === undefined) return null;
  return key.toLowerCase() === 'arrows' ? 'or use the arrow keys' : `or press ${key.length === 1 ? key : key[0]!.toUpperCase() + key.slice(1)}`;
}

/**
 * Velká výzva uprostřed, dokud hra čeká na první dotek: „Tap to start“,
 * jeden povel a na desktopu klávesa (řádek klávesy skryje CSS na dotyku).
 * Klepnutí jde skrz na plátno – ten dotek hru pustí. Mřížka posílá vlastní
 * řádek klávesy (`keys`), protože karty cílů mají čísla.
 */
export function FirstPrompt({ controlsHint, keys }: { readonly controlsHint: string; readonly keys?: string }) {
  const action = callToAction(controlsHint);
  const keyLine = keys ?? desktopKeys(controlsHint);
  return (
    <div className="play-first-prompt" data-testid="play-first-prompt" aria-hidden="true">
      <p className="play-first-prompt-start">Tap to start</p>
      {action !== '' && <p className="play-first-prompt-action" data-testid="play-first-prompt-action">{action}</p>}
      {keyLine !== null && <p className="play-first-prompt-keys">{keyLine}</p>}
    </div>
  );
}
