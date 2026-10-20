/**
 * Žánr Bouchání (P54C T6): z pěti děr vykukují cíle a hrdina do nich bouchá (ovládání `lanes`,
 * generátor `whack_holes` v `arcade/pieces/whack.ts`). Do čeho se bouchá, je věc obsazení, do které
 * věta střílí nebo se s ní pere (`shoot_at`, `fight`, výchozí krtek); čemu se hrdina vyhýbá (`avoid`,
 * výchozí zajíček), je hodný cíl – rána do něj stojí život.
 *
 * Hloubka: cíl `targets` krtků (`COUNT_PARAMS.whack.default.enemy`), tři třetiny se zkracujícím oknem,
 * 3 životy – hodný cíl a každý schovaný krtek nad dva volné ubere život. Robot vyhraje za 30–60 s,
 * nečinný hráč prohraje, než něco rozbije.
 *
 * Věty sem vede klasifikátor (T13, sloveso `whack` v `classify.ts`: bouchá se do toho, co vykukuje),
 * hraje ho buňka `whack.default`; režisér ho nabídne od T14.
 */

import { WHACK } from '../arcade/pieces/whack';
import { nounPhrase, plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí cíle, když je věta nejmenuje: krtek k rozbití a zajíček, kterého je škoda. */
export const WHACK_DEFAULTS = { target: 'mole', good: 'bunny' } as const;

/** Předmět slovesa úderu („whacks the moles“, „pop balloons“, „smash all the bugs“). */
const WHACK_OBJECT = /\b(?:whack|hit|pop|smash|squash|bonk|bop|tap|swat|bash|smack|thump)(?:s|es|ed|ing)?\s+(?:all\s+|the\s+|some\s+|every\s+|those\s+)*([a-z][a-z -]*)/;
/** „goblins peek out of barrels … whack them“: kdo vykukuje, je cíl, když předmět slovesa je zájmeno (P54C T13). */
const POPPER = /\b([a-z]+) (?:that |which |who )?(?:peek|pop|appear|emerge)(?:s|ing)? (?:out|up|from|in)\b/;
/** Díra, hrob nebo okno, odkud cíl vykukuje, není věc ke šetření („popping out of the garden holes“). */
const HIDEOUT = /(?:^| )(?:holes?|burrows?|graves?|craters?|barrels?|drains?|windows?|pipes?|tents?|ground|dirt|field|lawn)$/;
/** Hodný cíl z věty („but not the bunnies“, „don't hit the cats“, „spare the frogs“). */
const SPARE_OBJECT = /\b(?:but not|not the|never (?:whack|hit|pop|smash|squash)|don'?t (?:whack|hit|pop|smash|squash)|spare|avoid)\s+(?:the\s+|any\s+)?([a-z][a-z -]*)/;
/** „hit it“, „pop up“ nejsou věc v díře. */
const PRONOUN = /^(?:it|him|her|them|me|you|us|up|out|down)\b/;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

/** Podstatné jméno z předmětu slovesa, nebo `null`. */
function objectOf(pattern: RegExp, sentence: string): string | null {
  const found = pattern.exec(sentence);
  const phrase = found === null ? null : nounPhrase(found[1] as string);
  return phrase === null || PRONOUN.test(phrase) ? null : singular(phrase);
}

export const whackGenre: GenreModule<'whack'> = {
  id: 'whack',
  modes: ['default'],
  // Narážky žádné: věty vede sloveso `whack` klasifikátoru (T13) – narážka by přidala bod i úkolu („pop ten balloons“).
  cues: [],
  heroClasses: ['animal', 'humanoid', 'robot', 'monster'],
  paramBounds: {
    // 10–12 terčů robot na semínku 9 rozbije za 29,4–29,9 s, pod 30 s (G1; T14br1, 20 semínek, 13–50 terčů v pásmu).
    targets: { min: 13, max: WHACK.targets.max },
  },
  availability: () => 'ready',
  compile: (spec) => {
    const targets = spec.params?.targets ?? WHACK.targets.default;
    const target = castFor(spec, 'shoot_at', 'fight')?.label ?? WHACK_DEFAULTS.target;
    const good = castFor(spec, 'avoid')?.label ?? WHACK_DEFAULTS.good;
    const many = plural(singular(target), targets);
    const goods = plural(singular(good), 2);
    return legacySpec(spec, {
      control: 'lanes',
      controlParams: { generator: 'whack_holes', tuning: { targets } },
      archetype: 'combat_lite',
      title: `${titleCase(spec.hero)} Whack`,
      objective: {
        kind: 'defeat_targets',
        description: fit(120, `Whack ${String(targets)} ${many} as they pop up, but spare the ${goods}.`, `Whack ${String(targets)} ${many} as they pop up.`, `Whack ${String(targets)} of them as they pop up.`),
        count: targets,
        role: 'target',
      },
      mechanics: [livesMechanic()],
      roles: [
        { id: 'target', kind: 'target', label: target, count: targets },
        { id: 'hazard', kind: 'hazard', label: good },
      ],
      tutorial: { goalLine: fit(50, `Whack ${String(targets)} ${many}. Spare the ${goods}!`, `Whack ${String(targets)} ${many}!`, `Whack ${String(targets)} of them!`), controlsHint: 'Tap a hole to whack. Arrows and Space work too.' },
      mood: 'playful',
      targetDurationSec: 45,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Bouchání zná jen dvě role: do čeho se bouchá, a hodný cíl, kterého se nedotknout.
    let roles = (cast ?? []).filter((item) => !HIDEOUT.test(item.label)).map((item): CastItem => (item.does === 'avoid' ? item : { ...item, does: 'shoot_at' }));
    const text = sentence.toLowerCase();
    const struck = objectOf(WHACK_OBJECT, text) ?? objectOf(POPPER, text);
    if (struck !== null) roles = [{ label: struck, does: 'shoot_at' }, ...roles.filter((item) => item.label !== struck && item.does !== 'shoot_at')];
    const spared = objectOf(SPARE_OBJECT, text);
    if (spared !== null && spared !== struck) roles = [...roles.filter((item) => item.label !== spared && item.does !== 'avoid'), { label: spared, does: 'avoid' }];
    return {
      genre: 'whack',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
