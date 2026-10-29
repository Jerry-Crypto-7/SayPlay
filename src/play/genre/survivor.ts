/**
 * Žánr Přežití ve vlnách (P66 T5): hrdina se hýbe joystickem a střílí sám na nejbližšího nepřítele, nepřátelé z věty
 * chodí ve vlnách od okrajů arény, mezi vlnami hráč vybere 1 ze 3 vylepšení, poslední kolo je boss (ovládání
 * `survivor`, generátor `survivor_waves` v `arcade/pieces/survivor.ts`, háčky kol, vylepšení a vzácnosti nese
 * generátor sám).
 *
 * Obsazení: kdo chodí je nepřítel věty (`shoot_at`, `chase_me`, `fight`, `avoid`; výchozí goblin), boss je boss
 * režiséra (`spec.boss`), jinak velký nepřítel téhož druhu; co padlí nechají, je sbíraná věc věty (`collect`), jinak
 * krystal; čím hrdina střílí, je střela věty (`scenery` se slovesem `shoot`, „fires fireballs“), jinak výchozí střela.
 *
 * Hloubka: `enemies` nepřátel ve vlnách (`COUNT_PARAMS.survivor.default.enemy`), `rounds` kol (poslední boss);
 * 3 životy. Robot vyhraje za 60–90 s, nečinný hráč prohraje ve druhé vlně.
 *
 * Narážky pro klasifikátor žádné – věty k žánru dovede až P66 T12. Do té doby se žánr otevírá ručním specem
 * (`e2e/fixtures/p66-survivor-spec.json`) a překladem `compileWith(survivorGenre, …)`.
 */

import { BOSS_ATTACKS } from '../arcade/contract';
import { SURVIVOR, type SurvivorAttack, wavedEnemies } from '../arcade/pieces/survivor';
import { namedProjectiles } from '../compose/projectiles';
import { nounPhrase, plural, singular, withoutPossessor } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí obsazení, když ho věta nejmenuje. */
export const SURVIVOR_DEFAULTS = { enemy: 'goblin', drop: 'crystal' } as const;

/** Útok bosse režiséra (`BOSS_ATTACKS`) → útok, který boss přežití umí: hod a shoz jsou salva. */
const ATTACK_OF: Readonly<Record<(typeof BOSS_ATTACKS)[number], SurvivorAttack>> = { charge: 'charge', stomp: 'stomp', shoot: 'shoot', throw: 'shoot', drop: 'shoot' };

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

/** Kdo jde v hordách („fights waves of zombies“, „survives the skeletons“, „against hordes of slimes“). */
const FOE_OBJECT = /\b(?:fight|fights|fighting|battles?|battling|survives?|surviving|against|blasts?|blasting|shoots?|shooting|kills?|killing|slays?|slaying|fends? off|holds? off|fights? off)\s+(?:the\s+|all\s+|every\s+|endless\s+)*(?:(?:waves?|hordes?|swarms?|armies|army|packs?|hundreds|dozens|lots)\s+of\s+)?([a-z][a-z -]*)/;
/** „fights them“, „survives on“ nejsou nepřítel. */
const PRONOUN = /^(?:it|him|her|them|me|you|us|on|out|off|up|back|everything|everyone)\b/;

/** Nepřítel z předmětu slovesa boje, nebo `null`; střela věty („shoots fireballs“) nepřítelem není. */
function foeOf(sentence: string, ammo: string | undefined): string | null {
  const found = FOE_OBJECT.exec(withoutPossessor(sentence.toLowerCase()));
  const phrase = found === null ? null : nounPhrase(found[1] as string);
  if (phrase === null || PRONOUN.test(phrase)) return null;
  const label = singular(phrase);
  return label === ammo ? null : label;
}

export const survivorGenre: GenreModule<'survivor'> = {
  id: 'survivor',
  modes: ['default'],
  // Narážky dopíše T12 (P66): do té doby žánr klasifikátor nevybere sám.
  cues: [],
  heroClasses: ['humanoid', 'robot', 'animal', 'monster', 'vehicle'],
  paramBounds: {
    enemies: { min: SURVIVOR.enemies.min, max: SURVIVOR.enemies.max },
    rounds: { min: SURVIVOR.rounds.min, max: SURVIVOR.rounds.max },
  },
  // Hraje (překlad i svět), ale pro výběr zůstává `staged` jako šipky (T9): buňku receptu (`PRESETS`,
  // `compose/presets.ts`) přesune do živých až T12 se zapojením vět; `ready` bez ní shodí skladbu každé věty.
  availability: () => 'staged',
  compile: (spec) => {
    const enemies = spec.params?.enemies ?? SURVIVOR.enemies.default;
    const rounds = spec.params?.rounds ?? SURVIVOR.rounds.default;
    const foe = castFor(spec, 'shoot_at', 'chase_me', 'fight', 'avoid')?.label ?? SURVIVOR_DEFAULTS.enemy;
    const drop = castFor(spec, 'collect')?.label ?? SURVIVOR_DEFAULTS.drop;
    const ammo = spec.cast?.find((item) => item.does === 'scenery' && item.verb === 'shoot')?.label;
    const attack = spec.boss === undefined ? undefined : ATTACK_OF[spec.boss.attack];
    const one = singular(foe);
    // Kolik jich opravdu přijde: do vln se vejde nejvýš `waveCap` na vlnu.
    const total = wavedEnemies(enemies, rounds);
    const many = plural(one, total);
    const waves = rounds - 1;
    const tuning = {
      ...(enemies === SURVIVOR.enemies.default ? {} : { enemies }),
      ...(rounds === SURVIVOR.rounds.default ? {} : { rounds }),
      ...(attack === undefined || attack === 'charge' ? {} : { attack }),
    };
    const wavesText = waves === 1 ? 'a wave' : `${String(waves)} waves`;
    return legacySpec(spec, {
      control: 'survivor',
      controlParams: { generator: 'survivor_waves', ...(Object.keys(tuning).length === 0 ? {} : { tuning }) },
      archetype: 'combat_lite',
      title: fit(60, `${titleCase(spec.hero)} vs ${titleCase(plural(one, 2))}`, `${titleCase(spec.hero)} Survives`),
      objective: {
        kind: 'defeat_targets',
        description: fit(120, `Survive ${String(total)} ${many} in ${wavesText}, pick an upgrade after each, then beat the boss.`, `Survive ${wavesText} of ${many}, then beat the boss.`, 'Survive every wave, then beat the boss.'),
        count: Math.min(50, total),
        role: 'enemy',
      },
      mechanics: [livesMechanic()],
      roles: [
        { id: 'enemy', kind: 'chaser', label: foe, count: Math.min(50, total) },
        // Boss bez režiséra je velký nepřítel téhož druhu: scéna ho kreslí modelem nepřítele, role navíc by ho přebila.
        ...(spec.boss === undefined ? [] : [{ id: 'boss', kind: 'target' as const, label: spec.boss.role }]),
        { id: 'drop', kind: 'collectible', label: drop },
        ...(ammo === undefined ? [] : [{ id: 'ammunition', kind: 'item' as const, label: ammo }]),
      ],
      tutorial: {
        goalLine: fit(50, `Survive ${wavesText} of ${many}, then the boss!`, `Survive ${wavesText}, then beat the boss!`, 'Survive, then beat the boss!'),
        controlsHint: 'Drag or arrows to move. You fire by yourself.',
      },
      mood: 'tense',
      targetDurationSec: 75,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Přežití zná nepřítele, sbíranou věc a střelu: ostatní věci z věty chodí s nepřítelem.
    let roles: CastItem[] = (cast ?? []).filter((item) => item.does !== 'reach').map((item): CastItem => (item.does === 'collect' || item.does === 'scenery' ? item : { ...item, does: 'shoot_at' }));
    const ammo = namedProjectiles(sentence)[0];
    const foe = foeOf(sentence, ammo?.label);
    if (foe !== null) roles = [{ label: foe, does: 'shoot_at' }, ...roles.filter((item) => item.label !== foe && item.does !== 'shoot_at')];
    const withAmmo = ammo === undefined || roles.some((item) => item.label === ammo.label) ? roles : [...roles, { label: ammo.label, does: 'scenery' as const, verb: 'shoot' }];
    return {
      genre: 'survivor',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(withAmmo.length === 0 ? {} : { cast: withAmmo.slice(0, 4) }),
    };
  },
};
