/**
 * Žánr Obrana pruhů (P54C T7): vlny nepřátel jdou pěti pruhy k hradbě a hrdina je zastaví (ovládání
 * `lanes`, generátor `lane_defense` v `arcade/pieces/lane-defense.ts`). Kdo jde, je nepřítel z obsazení
 * (`shoot_at`, `chase_me`, `fight`, výchozí goblin); co se brání, je předmět „defend / protect / guard X“
 * (`reach`, výchozí hrad). Ťuk vystřelí do pruhu, držení postaví obránce.
 *
 * Hloubka: `enemies` nepřátel ve čtyřech vlnách (`COUNT_PARAMS.defense.default.enemy`), poslední končí
 * bossem; 3 životy – nepřítel u hradby ubere život, boss všechny. Robot vyhraje za 45–90 s, nečinný
 * hráč prohraje, než první vlna dojde celá.
 *
 * Věty sem vede klasifikátor (T13, sloveso `defend` obrany v `classify.ts`: brání se místo před mnoha,
 * „tower defense“), hraje ho buňka `defense.default`; režisér ho nabídne od T14.
 */

import { DEFENSE } from '../arcade/pieces/lane-defense';
import { nounPhrase, plural, singular, withoutPossessor } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí obsazení, když ho věta nejmenuje: goblini proti hradu. */
export const DEFENSE_DEFAULTS = { enemy: 'goblin', keep: 'castle' } as const;

/** Bráněná věc („defend the castle“, „protect our village“, „guard the gate“). */
const KEEP_OBJECT = /\b(?:defend|protect|guard|save|hold)(?:s|ed|ing)?\s+(?:the\s+|your\s+|our\s+|his\s+|her\s+|their\s+|my\s+)?([a-z][a-z -]*)/;
/** Kdo jde („from waves of goblins“, „against the orcs“, „stop the skeletons“). */
const FOE_OBJECT = /\b(?:from|against|stop|stops|stopping|repel|repels|fend off|hold off|fight off|shoot|shoots|keep(?:s|ing)?(?= (?:the |all |those )?[a-z]+ (?:from|out of) ))\s+(?:the\s+|all\s+|every\s+)*(?:(?:waves?|hordes?|swarms?|armies|army|lines?|packs?)\s+of\s+)?([a-z][a-z -]*)/;
/** „protect them“, „hold on“ nejsou věc ani nepřítel. */
const PRONOUN = /^(?:it|him|her|them|me|you|us|on|out|off|up|back)\b/;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

/** Podstatné jméno z předmětu slovesa, nebo `null`. */
function objectOf(pattern: RegExp, sentence: string): string | null {
  const found = pattern.exec(sentence);
  const phrase = found === null ? null : nounPhrase(found[1] as string);
  return phrase === null || PRONOUN.test(phrase) ? null : singular(phrase);
}

export const defenseGenre: GenreModule<'defense'> = {
  id: 'defense',
  modes: ['default'],
  // Narážky žádné: věty vede sloveso obrany klasifikátoru (T13) – narážka by přidala bod i rvačce („defends himself“).
  cues: [],
  heroClasses: ['humanoid', 'robot', 'animal', 'monster', 'vehicle'],
  paramBounds: {
    enemies: { min: DEFENSE.enemies.min, max: DEFENSE.enemies.max },
  },
  availability: () => 'ready',
  compile: (spec) => {
    const enemies = spec.params?.enemies ?? DEFENSE.enemies.default;
    const foe = castFor(spec, 'shoot_at', 'chase_me', 'fight')?.label ?? DEFENSE_DEFAULTS.enemy;
    const keep = castFor(spec, 'reach')?.label ?? DEFENSE_DEFAULTS.keep;
    const many = plural(singular(foe), enemies);
    return legacySpec(spec, {
      control: 'lanes',
      controlParams: { generator: 'lane_defense', tuning: { enemies } },
      archetype: 'combat_lite',
      title: `${titleCase(spec.hero)} Defense`,
      objective: {
        kind: 'defeat_targets',
        description: fit(120, `Hold the ${keep} against ${String(enemies)} ${many} and their boss.`, `Hold the ${keep} against ${String(enemies)} ${many}.`, `Hold the ${keep} against every wave.`),
        count: enemies,
        role: 'chaser',
      },
      mechanics: [livesMechanic()],
      roles: [
        { id: 'chaser', kind: 'chaser', label: foe, count: enemies },
        { id: 'castle', kind: 'prop', label: keep },
      ],
      // P63 T4: věta s počtem („from ten zombies“) ho řekne i v cíli HUD; bez počtu cíl jako dřív.
      tutorial: { goalLine: spec.counts?.enemy === undefined ? fit(50, `Hold the ${keep}! Stop every ${singular(foe)}.`, `Stop every ${singular(foe)}!`, 'Hold the line!') : fit(50, `Hold the ${keep}! Stop ${String(enemies)} ${many}.`, `Stop ${String(enemies)} ${many}!`, `Stop ${String(enemies)} of them!`), controlsHint: 'Tap a lane to shoot. Hold a lane to place a guard. Arrows and Space work too.' },
      mood: 'tense',
      targetDurationSec: 60,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Obrana zná jen dvě role: kdo jde k hradbě, a co se brání.
    let roles = (cast ?? []).filter((item) => item.does !== 'collect').map((item): CastItem => (item.does === 'reach' ? item : { ...item, does: 'shoot_at' }));
    // „from the king's guards“: vlastník není ten, kdo jde k hradbě (P54C T13).
    const text = withoutPossessor(sentence.toLowerCase());
    const keep = objectOf(KEEP_OBJECT, text);
    const foe = objectOf(FOE_OBJECT, text);
    if (foe !== null && foe !== keep) roles = [{ label: foe, does: 'shoot_at' }, ...roles.filter((item) => item.label !== foe && item.does !== 'shoot_at')];
    if (keep !== null) roles = [...roles.filter((item) => item.label !== keep && item.does !== 'reach'), { label: keep, does: 'reach' }];
    return {
      genre: 'defense',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
