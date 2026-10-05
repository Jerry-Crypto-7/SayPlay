/**
 * Žánr Aréna (P32): volný pohyb po ohraničené ploše. Režimy *uteč*, *sbírej*
 * a *bojuj* (P32E T4) jdou na generátory režimů přes `controlParams.generator`:
 * `arena_escape` (sbírej věci, nebo přežij, a pronásledovatelé honí),
 * `arena_collect` (sbírej, nikdo nehoní) a `fight` (poraz nepřátele).
 * Ovládání ve specu je `move_free` – z téže rodiny, takže jeho parametry
 * (`seconds`) i doplňky soudí `readGameSpec` jako dřív; vlastní klíče režimu
 * nese `tuning` a validuje je schéma generátoru.
 *
 * Všechny tři režimy jdou od P36A T4 ve vlnách (`waves` v `tuning`): počet z
 * věty je věcí v jedné vlně, resp. soupeřů první vlny, a vln je tolik, aby
 * robot hrál 30–90 s; každá další vlna je těžší. Spec bez `waves` (uložené
 * hry) staví svět jako dřív.
 */

import { ESCAPE } from '../arcade/pieces/arena';
import { FIGHT, fightWaveCount } from '../arcade/pieces/fight';
import { WAVE_PLAN, itemWaveCount, survivalSeconds } from '../arcade/pieces/waves';
import { plural, singular } from '../draft/lexicon';
import { type GenreModule, type GenreSpecOf, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Klíče `spec.params`, které režim předá generátoru v `tuning`. */
const TUNING = {
  escape: ['chasers', 'chaserSpeed'],
  collect: [],
  fight: ['enemies', 'enemyHp', 'enemySpeed', 'playerHp'],
} as const;

function tuningOf(spec: GenreSpecOf<'arena'>, extra: Readonly<Record<string, number>>): Record<string, number> {
  const params = spec.params ?? {};
  const given = Object.fromEntries(TUNING[spec.mode].flatMap((key: string) => (params[key] === undefined ? [] : [[key, params[key]]])));
  return { ...given, ...extra };
}

function compileArena(spec: GenreSpecOf<'arena'>) {
  const title = titleCase(spec.hero);
  if (spec.mode === 'fight') {
    // „Two knights duel“: bez jmenovaného soupeře bojuje hrdina se sobě rovným.
    const rival = spec.enemy ?? spec.hero;
    const enemies = spec.params?.enemies ?? FIGHT.enemies.default;
    // Vlny: ležící soupeři vstanou silnější a přidají se noví; víc soupeřů z věty = delší zápas.
    const waves = fightWaveCount({ enemies, enemyHp: spec.params?.enemyHp ?? FIGHT.enemyHp.default });
    const rivals = plural(singular(rival), 2);
    return legacySpec(spec, {
      control: 'move_free',
      controlParams: { generator: 'fight', tuning: tuningOf(spec, { waves }) },
      archetype: 'combat_lite',
      title: `${title} Duel`,
      objective: { kind: 'defeat_targets', description: `Dodge the wind-up, strike back and knock out ${String(waves)} waves of ${rivals}.`, count: enemies, role: 'rival' },
      roles: [{ id: 'rival', kind: 'hazard', label: rival, count: enemies }],
      tutorial: { goalLine: `Knock out ${String(waves)} waves of ${rivals}.`, controlsHint: 'Drag or arrows to move, Attack or J to strike. Step aside when it winds up.' },
      // Životy souboje jsou knockouty: na 0 HP hrdina ztratí život a vstane s plným HP (P36A T2).
      mechanics: [livesMechanic()],
      mood: 'tense',
      targetDurationSec: 45,
    });
  }
  if (spec.mode === 'collect') {
    const items = spec.params?.items ?? ESCAPE.items.collectDefault;
    const thing = spec.collectible ?? 'coin';
    // Vlny: `items` věcí v každé, od druhé vbíhají pronásledovatelé, hodiny ukáže HUD.
    const waves = itemWaveCount(items, 0);
    const things = plural(singular(thing), items);
    return legacySpec(spec, {
      control: 'move_free',
      controlParams: { generator: 'arena_collect', tuning: { items, waves } },
      archetype: 'collect_exit',
      title: `${title} Hunt`,
      objective: { kind: 'collect', description: `Collect ${String(items)} ${things} in each of ${String(waves)} waves before time runs out.`, count: items, role: 'item' },
      roles: [{ id: 'item', kind: 'collectible', label: thing, count: items }],
      tutorial: { goalLine: `Collect ${String(items)} ${things} per wave, ${String(waves)} waves.`, controlsHint: 'Drag or arrows to move.' },
      mechanics: [livesMechanic()],
      mood: 'playful',
    });
  }
  const hunter = spec.enemy ?? 'hunter';
  const chasers = spec.params?.chasers ?? ESCAPE.chasers.default;
  const roles = [{ id: 'hunter', kind: 'chaser' as const, label: hunter, count: chasers }];
  if (spec.collectible !== undefined) {
    // Uteč a sbírej ve vlnách: `items` věcí v každé, každá vlna přivede pronásledovatele navíc a zrychlí.
    const items = spec.params?.items ?? ESCAPE.items.collectDefault;
    const waves = itemWaveCount(items, chasers);
    const things = plural(singular(spec.collectible), items);
    // Hlídka (P36A T8) jen při sběru: v přežití by nečinný hráč stráže přečkal a vyhrál.
    const patrol: Record<string, number> = spec.enemyMoves === 'patrol' ? { patrol: ESCAPE.patrolSight } : {};
    return legacySpec(spec, {
      control: 'move_free',
      controlParams: { generator: 'arena_escape', tuning: tuningOf(spec, { items, waves, ...patrol }) },
      // `chase_escape` čeká cíl `reach`; sběr s pronásledovatelem je `collect_exit` (bere i `chaser`).
      archetype: 'collect_exit',
      title: `${title} Escape`,
      objective: { kind: 'collect', description: `Collect ${String(items)} ${things} in each of ${String(waves)} waves before the ${hunter} catches you.`, count: items, role: 'item' },
      roles: [...roles, { id: 'item', kind: 'collectible', label: spec.collectible, count: items }],
      tutorial: { goalLine: `Grab ${String(items)} ${things} per wave, ${String(waves)} waves. Don't get caught.`, controlsHint: 'Drag or arrows to move.' },
      mechanics: [livesMechanic()],
      mood: 'tense',
    });
  }
  // Přežití: délka podle počtu pronásledovatelů z věty, na třetinách času přiběhne další a všichni zrychlí.
  const seconds = spec.params?.seconds ?? survivalSeconds(chasers);
  return legacySpec(spec, {
    control: 'move_free',
    controlParams: { generator: 'arena_escape', seconds, tuning: tuningOf(spec, { items: 0, waves: WAVE_PLAN.survivalWaves }) },
    archetype: 'survival_timer',
    title: `${title} Escape`,
    objective: { kind: 'survive', description: `Stay away from the ${hunter} for ${String(seconds)} seconds.`, seconds },
    mechanics: [{ id: 'timer', params: { id: 'clock', seconds, onEnd: 'win' } }, livesMechanic()],
    roles,
    tutorial: { goalLine: `Survive ${String(seconds)} seconds.`, controlsHint: 'Drag or arrows to move.' },
    mood: 'tense',
  });
}

const FIGHT_WORDS = /\b(fight|fights|fighting|duel|duels|dueling|duelling|battle|battles|box|boxes|boxing|spar|spars)\b/i;

export const arenaGenre: GenreModule<'arena'> = {
  id: 'arena',
  modes: ['escape', 'collect', 'fight'],
  cues: ['chase', 'catch', 'escape', 'run from', 'before it catches', 'collect', 'gather', 'fight', 'duel', 'battle', 'box'],
  heroClasses: ['animal', 'bird', 'robot', 'vehicle', 'humanoid', 'monster', 'prop'],
  paramBounds: {
    seconds: { min: 20, max: 80 },
    items: { min: 1, max: ESCAPE.items.max },
    chasers: { min: ESCAPE.chasers.min, max: ESCAPE.chasers.max },
    chaserSpeed: { min: ESCAPE.chaserSpeed.min, max: ESCAPE.chaserSpeed.max },
    enemies: { min: FIGHT.enemies.min, max: FIGHT.enemies.max },
    enemyHp: { min: FIGHT.enemyHp.min, max: FIGHT.enemyHp.max },
    enemySpeed: { min: FIGHT.enemySpeed.min, max: FIGHT.enemySpeed.max },
    playerHp: { min: FIGHT.playerHp.min, max: FIGHT.playerHp.max },
  },
  availability: () => 'ready',
  compile: compileArena,
  draftFill: (sentence, reading) => {
    const roles = draftRoles(sentence, reading);
    const cast = roles.cast ?? [];
    const mode = FIGHT_WORDS.test(sentence) ? 'fight' : cast.length > 0 && cast.every((item) => item.does === 'collect') ? 'collect' : 'escape';
    return { genre: 'arena', mode, ...roles };
  },
};
