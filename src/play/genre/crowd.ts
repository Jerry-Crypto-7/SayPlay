/**
 * Žánr Dav a brány (P54C T10, Count Masters): hrdina vede dav tratí, dvojice bran ve dvou pruzích ho násobí
 * a ubírají (+N, ×2, −N, ÷2), překážky v pruzích ho zmenší a na konci se dav bije s obrem (ovládání `crowd`,
 * generátor `crowd_track` v `arcade/pieces/crowd.ts`). Čemu se dav vyhýbá, je věc obsazení (`avoid` a ostatní
 * škůdci, výchozí pila); s kým se na konci bije, je věc `fight` (výchozí zlobr).
 *
 * Hloubka: 30 dvojic bran ve třech úsecích, které houstnou; síla obra plyne z délky trati; 3 životy – bere je překážka.
 *
 * Věty sem klasifikátor zatím nevede (T13b) a režisér ho nenabízí (`DIRECTOR_PENDING`); hraje ho buňka `crowd.default`.
 */

import { CROWD } from '../arcade/pieces/crowd';
import { plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí věci, když je věta nejmenuje: pila v pruhu a zlobr na konci trati (oba mají model v katalogu). */
export const CROWD_DEFAULTS = { obstacle: 'saw', boss: 'ogre' } as const;

/** Role obsazení, kterou dav hraje jako překážku v pruhu: všechno, co škodí. */
const OBSTACLE_DOES = ['avoid', 'chase_me', 'shoot_at', 'throw_at'] as const;

/** Soupeř na konci trati z věty: „beat the giant“, „defeat the dragon“, „storm the castle“. */
const BOSS_OBJECT = /\b(?:beat|defeat|fight|attack|storm|conquer|crush|topple|take down)s?\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*)?)/;

/** Slova, kterými jméno soupeře z věty nekončí. */
const TAIL = /\s+(?:at|in|on|with|and|while|before|after|to|by)$/;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

export const crowdGenre: GenreModule<'crowd'> = {
  id: 'crowd',
  modes: ['default'],
  // Narážky žádné: věty k žánru povede až klasifikátor (T13b), narážka by bod přidala i davům jiných her.
  cues: [],
  heroClasses: ['humanoid', 'animal', 'robot', 'monster'],
  paramBounds: {},
  availability: () => 'ready',
  compile: (spec) => {
    const obstacle = castFor(spec, ...OBSTACLE_DOES)?.label ?? CROWD_DEFAULTS.obstacle;
    const boss = castFor(spec, 'fight', 'reach')?.label ?? CROWD_DEFAULTS.boss;
    const hazards = plural(singular(obstacle), 2);
    return legacySpec(spec, {
      control: 'crowd',
      controlParams: { generator: 'crowd_track' },
      archetype: 'combat_lite',
      title: `${titleCase(spec.hero)} Army`,
      objective: {
        kind: 'defeat_targets',
        description: fit(120, `Pick the better gate to grow your crowd, dodge the ${hazards}, then beat the ${boss}.`, `Grow your crowd, then beat the ${boss}.`, 'Grow your crowd, then beat the boss.'),
        count: 1,
        role: 'boss',
      },
      mechanics: [{ ...livesMechanic(), params: { max: CROWD.lives } }],
      roles: [
        { id: 'obstacle', kind: 'hazard', label: obstacle },
        { id: 'boss', kind: 'target', label: boss },
      ],
      tutorial: {
        goalLine: fit(50, `Grow your crowd, then beat the ${boss}!`, 'Grow your crowd, then beat the boss!'),
        controlsHint: 'Drag left or right to pick a gate. Arrows work too.',
      },
      mood: 'playful',
      targetDurationSec: 60,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Dav zná jen dvě role: s kým se na konci bije, a čemu se cestou vyhýbá. Věci ke sběru dav nemá – rostou mu brány.
    let roles = (cast ?? []).filter((item) => item.does !== 'collect').map((item): CastItem => (item.does === 'fight' || item.does === 'reach' ? { ...item, does: 'fight' } : { ...item, does: 'avoid' }));
    const named = BOSS_OBJECT.exec(sentence.toLowerCase())?.[1]?.replace(TAIL, '');
    if (named !== undefined && named !== hero) roles = [...roles.filter((item) => item.label !== named && item.does !== 'fight'), { label: named, does: 'fight' }];
    return {
      genre: 'crowd',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
