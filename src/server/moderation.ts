/**
 * **Moderace promptu — první článek řetězu, před rezervací i před voláním.**
 *
 * Pořadí je součást kontraktu: odmítnutý prompt nesmí zamluvit rozpočet ani
 * dojít k poskytovateli. Kdyby moderace běžela až za rezervací, stačilo by
 * posílat zakázané prompty a strop by se vyčerpal na volání, která se nikdy
 * neuskuteční.
 *
 * ## Dvě třídy kontrol, každá s jiným účelem
 *
 * **Strukturální** — typ, prázdný text, délka. Chrání potrubí: prompt na deset
 * kilobajtů zaplatí vstupní tokeny a odpověď z něj stejně nevznikne.
 *
 * **Obsahová** — seznam zakázaných témat. Chrání demo, na které během soutěže
 * sáhne kdokoli, včetně porotce.
 *
 * ## Co tahle moderace neumí — a je potřeba to vědět předem
 *
 * Je to **lexikální shoda proti seznamu vzorů**. Neposílá nic do žádného
 * moderačního API (to by bylo placené volání, a placená cesta se podle
 * rozhodnutí ze 14. 8. 2026 nevolá) a nerozumí významu. Přeformulovaný nebo
 * cizojazyčný požadavek jí projde. Obstojí proti neopatrnému, ne proti
 * záměrnému — stejná mez a stejná formulace jako u `scripts/cleanroom-check.mjs`.
 *
 * Tvrdit v přihlášce nebo v reportu, že je vstup moderovaný strojově, se proto
 * nesmí bez téhle věty vedle.
 */

export type ModerationCategory =
  /** Prompt není řetězec. */
  | 'NOT_TEXT'
  /** Prázdný prompt nebo jen bílé znaky. */
  | 'EMPTY'
  /** Přes strop délky. */
  | 'TOO_LONG'
  /** Sedl na zakázané téma. */
  | 'DISALLOWED';

export interface DeniedTopic {
  readonly id: string;
  /**
   * Nesmí nést příznak `g` ani `y`. Obojí si drží `lastIndex` mezi voláními,
   * takže by týž vzor nad týmž textem střídavě sedl a nesedl.
   */
  readonly pattern: RegExp;
  readonly detail: string;
}

export interface ModerationRules {
  readonly maxChars: number;
  readonly denied: readonly DeniedTopic[];
}

export interface Allowed {
  readonly ok: true;
  /** Prompt po `trim()` — dál v řetězu jede tenhle, ne původní. */
  readonly prompt: string;
}

export interface Blocked {
  readonly ok: false;
  readonly category: ModerationCategory;
  /** Jméno pravidla, které rozhodlo. `null` u strukturálních kontrol. */
  readonly ruleId: string | null;
  readonly detail: string;
}

export type ModerationVerdict = Allowed | Blocked;

/**
 * Strop délky promptu.
 *
 * Nejdelší zmrazený prompt má pod 300 znaků, takže 2000 nechává velký prostor
 * a přitom drží vstupní část požadavku v řádu stovek tokenů.
 */
export const MAX_PROMPT_CHARS = 2000;

/**
 * Zakázaná témata popsaná jako **požadavky**, ne jako slovník urážek.
 *
 * Seznam slov by v tomhle veřejném repozitáři byl sám o sobě obsah, který sem
 * nepatří; vzory proto míří na tvar žádosti (sloveso plus předmět), ne na
 * jednotlivá slova.
 */
export const DEFAULT_DENIED_TOPICS: readonly DeniedTopic[] = [
  {
    id: 'sexual-minors',
    pattern: /\b(sexu\w*|erotic\w*|porn\w*)\b[\s\S]{0,40}\b(child|children|minor|kid|kids|dít\w*|dět\w*|nezletil\w*)\b|\b(child|children|minor|kid|kids|dít\w*|dět\w*|nezletil\w*)\b[\s\S]{0,40}\b(sexu\w*|erotic\w*|porn\w*)\b/i,
    detail: 'the prompt asks for sexual content involving minors',
  },
  {
    id: 'weapon-build',
    pattern: /\b(build|make|construct|synthesi[sz]e|vyrob\w*|sestroj\w*|nav[oó]d\w*)\b[\s\S]{0,40}\b(bomb|explosive|nerve agent|bomb\w*|výbušn\w*|nálož\w*)\b/i,
    detail: 'the prompt asks how to build a weapon or an explosive',
  },
  {
    id: 'self-harm-method',
    pattern: /\b(how to|jak se|návod\w*)\b[\s\S]{0,40}\b(kill myself|commit suicide|zabít|sebevražd\w*)\b/i,
    detail: 'the prompt asks for a method of self-harm',
  },
];

export const DEFAULT_MODERATION: ModerationRules = {
  maxChars: MAX_PROMPT_CHARS,
  denied: DEFAULT_DENIED_TOPICS,
};

export function moderatePrompt(
  prompt: unknown,
  rules: ModerationRules = DEFAULT_MODERATION,
): ModerationVerdict {
  if (typeof prompt !== 'string')
    return { ok: false, category: 'NOT_TEXT', ruleId: null, detail: 'prompt must be a string' };

  const trimmed = prompt.trim();
  if (trimmed.length === 0)
    return { ok: false, category: 'EMPTY', ruleId: null, detail: 'prompt is empty' };

  // Měří se text po `trim()`, protože ten jde dál. Kdyby se měřil původní,
  // šel by strop vyčerpat mezerami, které se stejně zahodí.
  if (trimmed.length > rules.maxChars)
    return {
      ok: false,
      category: 'TOO_LONG',
      ruleId: null,
      detail: `prompt is ${trimmed.length} characters, the limit is ${rules.maxChars}`,
    };

  for (const topic of rules.denied)
    if (topic.pattern.test(trimmed))
      return { ok: false, category: 'DISALLOWED', ruleId: topic.id, detail: topic.detail };

  return { ok: true, prompt: trimmed };
}
