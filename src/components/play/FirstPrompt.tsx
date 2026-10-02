/**
 * Výzva na startu (P28C T5, P33 T11). Mimo `Hud.tsx` ze stejného důvodu jako
 * `timer.ts` (P28E-R2): HUD mřížky táhne runtime a arkáda ho nepotřebuje.
 */

import { useSyncExternalStore } from 'react';

/** Klávesy, které nápověda nabízí vedle dotyku („Tap or Space …“). */
const KEY_WORD = 'space|arrows|a\\/d|w\\/s|down|up|enter|keys';

const COARSE_POINTER = '(pointer: coarse)';

const watchPointer = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(COARSE_POINTER);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/**
 * Hraje se prstem (P36C T2): nápověda pak mluví o gestech, jinak o klávesách.
 * `pointer: coarse` je telefon i tablet; notebook s dotykovým displejem má
 * hlavní ukazatel myš, takže dostane klávesy. Server neví – vrací klávesy.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(watchPointer, () => window.matchMedia(COARSE_POINTER).matches, () => false);
}

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

/** Klávesa za „nebo“ („Tap or Space“, „Drag or use A/D“); „drag up or down“ je směr tahu, ne klávesa. */
const KEY_AFTER = new RegExp(`(?<!\\bup)\\s+or\\s+(?:use\\s+)?(?:${KEY_WORD})\\b`, 'gi');
/** Písmeno klávesy za „nebo“ („Attack or J“) – jen velké, malé „a“ je člen. */
const LETTER_AFTER = /\s+or\s+[A-Z](?![\w/])/g;
/** Klávesy na začátku výčtu před dotykem („Arrows or drag“, „Up, Space or a second finger“). */
const KEY_BEFORE = new RegExp(`(?<=^|[.,;]\\s*)(?:${KEY_WORD})(?:,\\s*|\\s+or\\s+)`, 'gi');
/** Souvětí jen o klávesách („Arrows to move“) – prst ho neudělá. */
const KEYS_ONLY = new RegExp(`^(?:${KEY_WORD})\\b`, 'i');
const TOUCH_WORD = /\b(?:tap|swipe|drag|hold|finger|touch)\b/i;

/**
 * Nápověda pro dotyk (P33 T12, P36C T2): celá, jen bez kláves – „Tap or Space to
 * jump“ → „Tap to jump“, „Down or a second finger brakes“ → „A second finger
 * brakes“. Souvětí, které nabízí jen klávesy, vypadne („Arrows or A/D to move“).
 */
export function touchHint(controlsHint: string): string {
  const stripped = controlsHint.replace(KEY_AFTER, '').replace(LETTER_AFTER, '').replace(KEY_BEFORE, '');
  const kept: string[] = [];
  for (const clause of stripped.trim().split(/(?<=[,.;])\s+/)) {
    if (KEYS_ONLY.test(clause) && !TOUCH_WORD.test(clause)) {
      // Vypadlo poslední souvětí věty: věta končí tečkou u předchozího.
      const last = kept.length - 1;
      if (/[.!?]$/.test(clause) && last >= 0) kept[last] = kept[last]!.replace(/[,;]$/, '.');
      continue;
    }
    const opens = kept.length === 0 || /[.!?]$/.test(kept[kept.length - 1]!);
    kept.push(opens ? clause.charAt(0).toUpperCase() + clause.slice(1) : clause);
  }
  return kept.join(' ');
}

/** Klávesa prvního povelu pro desktop („Tap or Space to jump“ → „or press Space“); `null`, když ji nápověda nemá. */
export function desktopKeys(controlsHint: string): string | null {
  const key = new RegExp(`\\sor\\s+(${KEY_WORD})\\b`, 'i').exec(firstClause(controlsHint))?.[1];
  if (key === undefined) return null;
  return key.toLowerCase() === 'arrows' ? 'or use the arrow keys' : `or press ${key.length === 1 ? key : key[0]!.toUpperCase() + key.slice(1)}`;
}

/**
 * Velká výzva uprostřed, dokud hra čeká na první dotek: „Tap to start“,
 * jeden povel a na desktopu klávesa. Na dotyku povel z nápovědy bez kláves
 * (`touch` ji dodá, kde ji text hry neřekne – zóny plošinovky) a bez řádku
 * klávesy. Klepnutí jde skrz na plátno – ten dotek hru pustí. Mřížka posílá
 * vlastní řádek klávesy (`keys`), protože karty cílů mají čísla. Výzva kamaráda
 * (P36B T7) přidá nahoru, co porazit; hrál-li kamarád se živými změnami, řekne to.
 */
export function FirstPrompt({
  controlsHint,
  touch,
  keys,
  dare = null,
}: {
  readonly controlsHint: string;
  readonly touch?: string;
  readonly keys?: string;
  readonly dare?: { readonly goal: string; readonly changed: boolean } | null;
}) {
  const coarse = useCoarsePointer();
  const action = callToAction(coarse ? (touch ?? touchHint(controlsHint)) : controlsHint);
  const keyLine = coarse ? null : (keys ?? desktopKeys(controlsHint));
  return (
    <div className="play-first-prompt" data-testid="play-first-prompt" aria-hidden="true">
      {dare !== null && (
        <p className="play-first-prompt-dare" data-testid="play-dare-goal">
          {dare.goal}
          {dare.changed && <span className="play-first-prompt-note">Your friend changed the game while playing.</span>}
        </p>
      )}
      <p className="play-first-prompt-start">Tap to start</p>
      {action !== '' && <p className="play-first-prompt-action" data-testid="play-first-prompt-action">{action}</p>}
      {keyLine !== null && <p className="play-first-prompt-keys">{keyLine}</p>}
    </div>
  );
}
