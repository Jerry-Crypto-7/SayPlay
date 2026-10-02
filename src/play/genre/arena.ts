/**
 * Žánr Aréna (P32): volný pohyb po ohraničené ploše. Režimy *uteč*, *sbírej*
 * a *bojuj* (P32E T4) jdou na generátory režimů přes `controlParams.generator`:
 * `arena_escape` (sbírej věci, nebo přežij, a pronásledovatelé honí),
 * `arena_collect` (sbírej, nikdo nehoní) a `fight` (poraz nepřátele).
 * Ovládání ve specu je `move_free` – z téže rodiny, takže jeho parametry
 * (`seconds`) i doplňky soudí `readGameSpec` jako dřív; vlastní klíče režimu
 * nese `tuning` a validuje je schéma generátoru.
 */

import { ESCAPE } from '../arcade/pieces/arena';
import { FIGHT } from '../arcade/pieces/fight';
import { type GenreModule, type GenreSpecOf, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Délka kola přežití, když ji spec neříká; `arenaWinOf` bere 20–80 s. */
const ROUND_SECONDS = 40;

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
    return legacySpec(spec, {
      control: 'move_free',
      controlParams: { generator: 'fight', tuning: tuningOf(spec, {}) },
      archetype: 'combat_lite',
      title: `${title} Duel`,
      objective: { kind: 'defeat_targets', description: `Dodge the wind-up, strike back and knock out the ${rival}.`, count: enemies, role: 'rival' },
      roles: [{ id: 'rival', kind: 'hazard', label: rival, count: enemies }],
      tutorial: { goalLine: `Knock out the ${rival}.`, controlsHint: 'Drag or arrows to move, Attack or J to strike. Step aside when it winds up.' },
      // Životy souboje jsou knockouty: na 0 HP hrdina ztratí život a vstane s plným HP (P36A T2).
      mechanics: [livesMechanic()],
      mood: 'tense',
      targetDurationSec: 45,
    });
  }
  if (spec.mode === 'collect') {
    const items = spec.params?.items ?? ESCAPE.items.collectDefault;
    const thing = spec.collectible ?? 'coin';
    return legacySpec(spec, {
      control: 'move_free',
      controlParams: { generator: 'arena_collect', tuning: { items } },
      archetype: 'collect_exit',
      title: `${title} Hunt`,
      objective: { kind: 'collect', description: `Collect ${String(items)} ${thing}.`, count: items, role: 'item' },
      roles: [{ id: 'item', kind: 'collectible', label: thing, count: items }],
      tutorial: { goalLine: `Collect ${String(items)} ${thing}.`, controlsHint: 'Drag or arrows to move.' },
      mechanics: [livesMechanic()],
      mood: 'playful',
    });
  }
  const hunter = spec.enemy ?? 'hunter';
  const chasers = spec.params?.chasers ?? ESCAPE.chasers.default;
  const roles = [{ id: 'hunter', kind: 'chaser' as const, label: hunter, count: chasers }];
  if (spec.collectible !== undefined) {
    // Uteč a sbírej: výhra po sebrání N věcí, pronásledovatelé honí celou dobu.
    const items = spec.params?.items ?? ESCAPE.items.collectDefault;
    return legacySpec(spec, {
      control: 'move_free',
      controlParams: { generator: 'arena_escape', tuning: tuningOf(spec, { items }) },
      // `chase_escape` čeká cíl `reach`; sběr s pronásledovatelem je `collect_exit` (bere i `chaser`).
      archetype: 'collect_exit',
      title: `${title} Escape`,
      objective: { kind: 'collect', description: `Collect ${String(items)} ${spec.collectible} before the ${hunter} catches you.`, count: items, role: 'item' },
      roles: [...roles, { id: 'item', kind: 'collectible', label: spec.collectible, count: items }],
      tutorial: { goalLine: `Grab ${String(items)} ${spec.collectible}. Don't get caught.`, controlsHint: 'Drag or arrows to move.' },
      mechanics: [livesMechanic()],
      mood: 'tense',
    });
  }
  const seconds = spec.params?.seconds ?? ROUND_SECONDS;
  return legacySpec(spec, {
    control: 'move_free',
    controlParams: { generator: 'arena_escape', seconds, tuning: tuningOf(spec, { items: 0 }) },
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
    const mode = FIGHT_WORDS.test(sentence) ? 'fight' : roles.enemy === undefined && roles.collectible !== undefined ? 'collect' : 'escape';
    return { genre: 'arena', mode, ...roles };
  },
};
