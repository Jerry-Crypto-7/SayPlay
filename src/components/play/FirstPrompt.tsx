/**
 * Výzva na startu (P28C T5, P33 T11). Mimo `Hud.tsx` ze stejného důvodu jako
 * `timer.ts` (P28E-R2): HUD mřížky táhne runtime a arkáda ho nepotřebuje.
 */

import { type ReactNode, useSyncExternalStore } from 'react';

/** Klávesy, které nápověda nabízí vedle dotyku („Tap or Space …“). */
const KEY_WORD = 'space|arrows|wasd|a\\/d|w\\/s|down|up|enter|keys';

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

/** Klávesy za „nebo“ („Tap or Space“, „Drag or use A/D“, „, or use arrows or WASD“); „drag up or down“ je směr tahu, ne klávesa. */
const KEY_AFTER = new RegExp(`(?<!\\bup),?\\s+or\\s+(?:use\\s+)?(?:${KEY_WORD})(?:\\s+or\\s+(?:${KEY_WORD}))*\\b`, 'gi');
/** Písmena kláves za „nebo“ („Attack or J“, „Tap the lane, or D F J K, on the beat“) – jen velká, malé „a“ je člen. */
const LETTER_AFTER = /,\s+or\s+[A-Z](?:\s+[A-Z])*(?![\w/]),|\s+or\s+[A-Z](?:\s+[A-Z])*(?![\w/])/g;
/** Věta jen pro klávesnici („Keys: arrows aim, hold Space.“) – „hold“ v ní je klávesa, ne prst. */
const KEYS_SENTENCE = /(?:^|\s+)Keys?:[^.!?]*[.!?]?/g;
/** Klávesy na začátku věty před dotykem („Move with arrows or WASD, or drag to chase.“ → „drag to chase.“). */
const KEYS_LEAD = new RegExp(`(?<=^|[.!?]\\s+)\\w+\\s+with\\s+(?:${KEY_WORD})(?:\\s+or\\s+(?:${KEY_WORD}))*,?\\s+or\\s+`, 'gi');
/** Písmeno klávesy před náhradou („F or Fire to shoot“ → „Fire to shoot“). */
const LETTER_LEAD = /(?<=^|[.!?,;]\s+)[A-Z]\s+or\s+/g;
/** Souvětí, které začíná písmenem klávesy („M toggles sound.“); „A“ a „I“ jsou slova. */
const LETTER_FIRST = /^[B-HJ-Z]\s/;
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
  const stripped = controlsHint
    .replace(KEYS_SENTENCE, '')
    .replace(KEYS_LEAD, '')
    .replace(LETTER_LEAD, '')
    .replace(KEY_AFTER, '')
    .replace(LETTER_AFTER, '')
    .replace(KEY_BEFORE, '');
  const kept: string[] = [];
  for (const clause of stripped.trim().split(/(?<=[,.;])\s+/)) {
    if ((KEYS_ONLY.test(clause) && !TOUCH_WORD.test(clause)) || LETTER_FIRST.test(clause)) {
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
  return key.toLowerCase() === 'arrows' ? 'or use the arrow keys' : `or press ${key === key.toUpperCase() ? key : key[0]!.toUpperCase() + key.slice(1)}`;
}

/** Náhradní vstup za „nebo“ v dalších povelech („F or Fire“ → „F“); „drag up or down“ je směr tahu, ne náhrada. */
const MORE_ALTERNATIVE = new RegExp(`(?<!\\bup)\\s+or\\s+(?:${KEY_WORD}|tap|swipe|click|drag|fire)\\b`, 'gi');
/** Povel je „<vstup> to <sloveso>“ nebo souvětí, které začíná gestem; rada („Step aside when …“) povel není. */
const COMMAND = /\bto\s+[a-z]+/i;
const GESTURE_FIRST = /^(?:tap|swipe|drag|hold|let go|press|click)\b/i;
/** Písmeno klávesy před náhradou („F or Fire“) – prst ho nezmáčkne. */
const LETTER_BEFORE = /^[A-Z]\s+or\s+/;

const clauses = (hint: string): string[] =>
  hint
    .trim()
    .split(/(?<=[.!?])\s+/)
    .flatMap((sentence) => sentence.split(/[,;]\s*/))
    .map((clause) => clause.replace(/[.!?]+$/, '').trim())
    .filter((clause) => clause !== '');

const commands = (list: readonly string[]): string[] =>
  list
    .filter((clause) => !/^or\b/i.test(clause) && (COMMAND.test(clause) || GESTURE_FIRST.test(clause)))
    .map((clause) => clause.replace(MORE_ALTERNATIVE, '').trim())
    .map((clause) => clause.charAt(0).toUpperCase() + clause.slice(1));

const verbOf = (command: string): string => /\bto\s+([a-z]+)/i.exec(command)?.[1]?.toLowerCase() ?? command.toLowerCase();

/**
 * Další povely nápovědy pod prvním (P39 T10): plošinovka se střelbou řekne skok
 * i střelbu, ne jen „Arrows to move“. `primary` je text, ze kterého karta bere
 * první povel; `extra` (dotyk se zónami) doplní povely nápovědy hry, které zóny
 * neříkají – bez klávesy písmenem.
 */
export function controlLines(primary: string, extra?: string): string[] {
  const all = clauses(primary);
  const lines = commands(all.slice(1));
  if (extra === undefined) return lines;
  const said = new Set(commands(all).map(verbOf));
  const more = commands(clauses(touchHint(extra)).map((clause) => clause.replace(LETTER_BEFORE, ''))).filter((line) => !said.has(verbOf(line)));
  return [...lines, ...more];
}

/** Klávesa první nápovědy, kterou karta řekne rovnou ve výzvě startu („Click or press Space“). */
const SPACE_KEY = 'or press Space';

/** Výzva startu (P70C T2): prst klepe, desktop kliká – Space jen tam, kde ho hra opravdu bere jako první povel. */
/** Ovládání na dotyku: nápověda zón (`ZONE_HINTS`, plošinovka „Hold left to run, tap right to jump.“), jinak nápověda hry bez kláves – stejná na kartě i v listu About (R2 P70C). */
export const touchControls = (controlsHint: string, touch?: string): string => touch ?? touchHint(controlsHint);

export const startLine = (coarse: boolean, keyLine: string | null): string => (coarse ? 'Tap to start' : keyLine === SPACE_KEY ? 'Click or press Space' : 'Click to start');

/**
 * Karta uprostřed, dokud hra čeká na první dotek (P70C T2): jak vyhrát
 * (`goal`), jak prohrát (`lose`, `loseLineOf`), ovládání a výzva startu – na
 * dotyku „Tap to start“, na desktopu „Click or press Space“. Na dotyku povel
 * z nápovědy bez kláves (`touch` ji dodá, kde ji text hry neřekne – zóny
 * plošinovky) a bez řádku klávesy. Klepnutí jde skrz na plátno – ten dotek hru
 * pustí. Mřížka posílá vlastní řádek klávesy (`keys`), protože karty cílů mají
 * čísla. Výzva kamaráda (P36B T7) přidá nahoru, co porazit; hrál-li kamarád se
 * živými změnami, řekne to. Kolo řetězce mikroher kartu zapojí stejně.
 */
export function FirstPrompt({
  controlsHint,
  touch,
  keys,
  goal,
  lose = null,
  dare = null,
  read,
}: {
  /** Jak hra větu přečetla (`StartRead`, P73B T2) – nahoře na kartě. */
  readonly read?: ReactNode;
  readonly controlsHint: string;
  readonly touch?: string;
  readonly keys?: string;
  /** Cíl hry (`tutorial.goalLine`). */
  readonly goal?: string;
  /** Jak se prohrává (`loseLineOf`); `null` = hra prohrát nejde. */
  readonly lose?: string | null;
  readonly dare?: { readonly goal: string; readonly changed: boolean } | null;
}) {
  const coarse = useCoarsePointer();
  const action = callToAction(coarse ? touchControls(controlsHint, touch) : controlsHint);
  const keyLine = coarse ? null : (keys ?? desktopKeys(controlsHint));
  const more = coarse ? controlLines(touchControls(controlsHint, touch), touch === undefined ? undefined : controlsHint) : controlLines(controlsHint);
  return (
    <div className="play-first-prompt" data-testid="play-first-prompt" aria-hidden="true">
      {read}
      {dare !== null && (
        <p className="play-first-prompt-dare" data-testid="play-dare-goal">
          {dare.goal}
          {dare.changed && <span className="play-first-prompt-note">Your friend changed the game while playing.</span>}
        </p>
      )}
      {goal !== undefined && goal !== '' && (
        <p className="play-first-prompt-goal" data-testid="play-first-prompt-goal">
          {goal}
        </p>
      )}
      {lose !== null && (
        <p className="play-first-prompt-lose" data-testid="play-first-prompt-lose">
          {lose}
        </p>
      )}
      {action !== '' && <p className="play-first-prompt-action" data-testid="play-first-prompt-action">{action}</p>}
      {keyLine !== null && keyLine !== SPACE_KEY && <p className="play-first-prompt-keys">{keyLine}</p>}
      {more.map((line) => (
        <p key={line} className="play-first-prompt-more" data-testid="play-first-prompt-more">
          {line}
        </p>
      ))}
      <p className="play-first-prompt-start" data-testid="play-first-prompt-start">
        {startLine(coarse, keyLine)}
      </p>
    </div>
  );
}
