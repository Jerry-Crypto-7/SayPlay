/**
 * Podklad prostředí, která porota v živém běhu nepoznala (P30B T6,
 * `evals/play/p30b/losses.md`), nad zmrazenými AI specy z `live.json`.
 * Béžová, kterou porota viděla na Marsu, Měsíci i v nemocnici, byla výchozí
 * paleta plátna (`PALETTES.harbor.sand`), ne barva sady: tu mřížka od P30B
 * dostává ze `sceneLook(theme).ground`. Snímky: `e2e/p30b-settings.spec.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOOKS, lookOf, sceneLook } from '../arcade/look';
import type { GameSpecV1 } from '../spec';

const LIVE = JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p30b/live.json'), 'utf8')) as {
  sentences: { id: string; spec: GameSpecV1 }[];
};
const theme = (id: string) => LIVE.sentences.find((entry) => entry.id === id)!.spec.theme;

describe('sceneLook', () => {
  it.each([
    // Model píše Marsu sadu pouště, Měsíci vesmír (hnědá zem = Mars) a nemocnici nic (klíčová slova → hřbitov).
    ['h04', 'Mars', '#b5532f'],
    ['h08', 'moon', '#a3a3a3'],
    ['h09', 'hospital', '#d3ddd9'],
    ['s069', 'cave', LOOKS.cave.ground],
    // „icy moon“ zůstává sněhem sady, Měsíc ho nepřebije.
    ['h06', 'icy moon', LOOKS.snow.ground],
  ])('%s %s: ground %s', (id, _name, ground) => {
    expect(sceneLook(theme(id)).ground).toBe(ground);
  });

  it('keeps the set untouched when the sentence names no place of its own', () => {
    // „Along the beach“ (j04) má od P46G kit pláže, beze změny zůstává „On a volcano“.
    expect(sceneLook(theme('h07'))).toBe(LOOKS[lookOf(theme('h07'))]);
  });

  it('s022 tower: castle scenery and stone platforms', () => {
    const look = sceneLook(theme('s022'));
    expect(look.props).toEqual(LOOKS.castle.props);
    expect(look.block).toEqual(LOOKS.castle.block);
    expect(look.block).toBeDefined();
  });

  it('s058 jungle river: the race runs on water, a jungle road does not', () => {
    expect(sceneLook(theme('s058')).afloat).toBe(true);
    expect(sceneLook({ ...theme('s058'), setting: 'A jungle road full of crocodiles' }).afloat).toBeFalsy();
  });

  it('s050 snow fort: the blocks the kids stand on are snow', () => {
    const block = sceneLook(theme('s050')).block;
    expect(block).toEqual(LOOKS.snow.block);
    expect(block?.[1]).toBe(LOOKS.snow.ground);
  });
});
