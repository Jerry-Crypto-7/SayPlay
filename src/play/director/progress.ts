/**
 * Kroky režie, které hráč vidí během čekání na AI verzi (P73C T2).
 *
 * Jen skutečné fáze potrubí a skutečné volby režiséra, nic vymyšleného: čtení věty, volání modelu, volby z první
 * přečtené odpovědi (hrdina, soupeř, místo, ovládání), kontrola robotem a opravné kolo. Model dnes po tokenech
 * nestreamuje (codex-cli vrací celé kolo, chat API jde bez `stream`), takže volby přijdou naráz po odpovědi;
 * klient je ukazuje po jedné (`UpgradeBanner`).
 *
 * Záznam kroků drží proces v paměti podle id fronty práce (`upgradeQueueId`), jako `queued` a `reading`: dotaz,
 * který trefí jinou instanci, kroky nemá a klient ukáže stav bez nich.
 */

import type { GameSpecV1 } from '../spec';

export type DirectorStep =
  | { readonly kind: 'reading' | 'directing' | 'checking' | 'fixing' }
  | { readonly kind: 'hero' | 'rival' | 'place' | 'controls'; readonly value: string };

/** Nejdelší hodnota volby v kroku; delší se zkrátí na hranici slova (pilulka nezalamuje). */
export const STEP_VALUE_MAX = 32;

/** Kolik kroků jedna práce zapíše; další se zahodí (běh s opravami a druhým pokusem jich má kolem 15). */
export const MAX_STEPS = 24;

/** Kolik prací si proces pamatuje; nad tím zapomene nejstarší. */
export const MAX_TRACKED = 1000;

/** Text kroku anglicky podle `docs/brand/docs/11-voice-copy.md`. */
export function stepText(step: DirectorStep): string {
  switch (step.kind) {
    case 'reading':
      return 'Reading your idea…';
    case 'directing':
      return 'Building the world…';
    case 'checking':
      return 'Checking it can be won…';
    case 'fixing':
      return 'Fixing one thing…';
    case 'hero':
      return `Hero: ${step.value}`;
    case 'rival':
      return `Rival: ${step.value}`;
    case 'place':
      return `Place: ${step.value}`;
    case 'controls':
      return `Controls: ${step.value}`;
  }
}

function fit(text: string): string {
  const plain = text.trim().replace(/\s+/g, ' ');
  if (plain.length <= STEP_VALUE_MAX) return plain;
  const cut = plain.slice(0, STEP_VALUE_MAX + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 8 ? cut.slice(0, space) : plain.slice(0, STEP_VALUE_MAX)).replace(/[,;:.]$/, '')}…`;
}

/**
 * Soupeř: kdo hráče honí, pak čemu uhýbá; hra bez nich soupeře nemá. Na co hráč míří (`target`), soupeř není –
 * oracle T5 ukázal „Rival: goal“ u hry, kde se střílí do branek a uhýbá šiškám.
 */
const RIVAL_KINDS: readonly (readonly string[])[] = [['chaser', 'patrol'], ['hazard']];

/** Volby režiséra v hotové hře: hrdina, soupeř, místo a první věta nápovědy ovládání. Co hra nemá, chybí. */
export function picksOf(spec: GameSpecV1): DirectorStep[] {
  const hero = spec.roles.find((role) => role.kind === 'player')?.label;
  const rival = RIVAL_KINDS.map((kinds) => spec.roles.find((role) => kinds.includes(role.kind))).find((role) => role !== undefined)?.label;
  const controls = spec.tutorial.controlsHint.split(/(?<=[.!])\s/)[0]!.replace(/[.!]$/, '');
  const picks: [DirectorStep['kind'], string | undefined][] = [['hero', hero], ['rival', rival], ['place', spec.theme.setting], ['controls', controls]];
  return picks.flatMap(([kind, value]) => (value === undefined || value.trim() === '' ? [] : [{ kind, value: fit(value) } as DirectorStep]));
}

const STEPS = Symbol.for('worldstream.play.director-steps');

function log(): Map<string, string[]> {
  const holder = globalThis as { [STEPS]?: Map<string, string[]> };
  holder[STEPS] ??= new Map();
  return holder[STEPS];
}

/**
 * Zapíše krok práce `id`. Čtení a volání modelu jen jednou (druhý pokus s pokynem je nehlásí znovu), stejný krok
 * hned po sobě a volbu, která už zazněla, taky ne. Záznam jen přibývá, takže klient pozná nové kroky podle pořadí.
 */
export function recordStep(id: string, step: DirectorStep): void {
  const map = log();
  let steps = map.get(id);
  if (steps === undefined) {
    if (map.size >= MAX_TRACKED) map.delete(map.keys().next().value!);
    steps = [];
    map.set(id, steps);
  }
  const text = stepText(step);
  const once = step.kind === 'reading' || step.kind === 'directing' || 'value' in step;
  if (steps.length >= MAX_STEPS || steps.at(-1) === text || (once && steps.includes(text))) return;
  steps.push(text);
}

/** Kroky práce `id` v pořadí; prázdné, když o ní proces neví. */
export function stepsOf(id: string): readonly string[] {
  return log().get(id) ?? [];
}

/** Jen pro testy. */
export function __resetSteps(): void {
  log().clear();
}
