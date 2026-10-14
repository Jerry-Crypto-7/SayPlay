/**
 * Výběr modelu z popisku role (P26 T12): celý katalog, hlava fráze, synonyma,
 * záložní kategorie postavy – a žádná kategorie u věci, kterou katalog nemá.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import duel from '../arcade/__fixtures__/duel.json';
import flap from '../arcade/__fixtures__/flap.json';
import platform from '../arcade/__fixtures__/platform.json';
import runner from '../arcade/__fixtures__/runner.json';
import shooter from '../arcade/__fixtures__/shooter.json';
import steer from '../arcade/__fixtures__/steer.json';
import throwGame from '../arcade/__fixtures__/throw.json';
import { enemyModel, heroModel, modelOf, modelPath, propModels, riggedCharacter } from '../arcade/models';
import { lookOf } from '../arcade/look';
import { draftGameSpec } from '../draft';
import { compileGenre } from '../genre';
import type { GenreSpec } from '../genre/contract';
import type { GameSpecV1 } from '../spec';

import { legacyDraft } from './legacy-draft';

const withLabel = (fixture: unknown, id: string, label: string): GameSpecV1 => {
  const spec = structuredClone(fixture) as GameSpecV1;
  spec.roles = spec.roles.map((role) => (role.id === id ? { ...role, label } : role));
  return spec;
};

describe('arcade model choice from role labels', () => {
  it.each([
    ['dog', 'dog'], // mimo složku her – dřív kovboj
    ['cardboard robot', 'robot'], // hlava fráze, ne první slovo
    ['brave little puppies', 'dog'], // synonymum v množném čísle
    ['kitten', 'cat'], // tag katalogu
    ['zombies', 'cc0-zombie'], // přesný model CC0 přebije náhradu
    ['ogres', 'gen3d-ogre'], // od 28. 9. vlastní model z gen3d
    ['demons', 'goblin'], // bez modelu náhradní příšera
    ['a small bird', 'bird'], // tag `bird` nese hnízdo, věta myslí ptáka
    ['space bunny', 'rigged:pet-bunny'], // od P35 T1 králík z Cube Pets, ne křeček
    ['grizzly bear', 'gen3d-bear'], // od 28. 9. vlastní model z gen3d
    ['wild lizard', 'fox'], // kategorie zvíře
    ['mall security guard', 'gen3d-guard'], // vlastní model z gen3d (e5b840b) přebije kategorii člověk
    ['angry bulldozer', 'gen3d-bulldozer'], // od 28. 9. vlastní model z gen3d
    ['angry forklift', 'gen3d-forklift'], // od P37D vlastní model z gen3d
    ['angry mech', 'robot'], // kategorie stroj
    ['battle tank', 'cc0-tank'], // CC0 tank, ne plynová bomba `cc0-gas-tank` (P26A T11)
  ])('%s → %s', (label, model) => {
    expect(modelOf(label, true)).toBe(model);
  });

  it('a thing the catalog lacks gets no category and keeps the role default', () => {
    // Vzducholoď má od P46F model z gen3d (`gen3d-blimp`), věc bez modelu je teď periskop.
    expect(modelOf('periscope', true)).toBeUndefined();
    expect(heroModel(withLabel(runner, 'player', 'periscope'))).toBe('explorer');
    expect(enemyModel(withLabel(shooter, 'enemy', 'angry balloons'))).toBe('gen3d-balloon');
    expect(enemyModel(withLabel(shooter, 'enemy', 'angry staplers'))).toBe('robot');
    // Zástupci (hydrant za kropítko) skončili v P30B T4: kropítko má vlastní model, věc bez modelu zůstane tělem jádra.
    expect(propModels(withLabel(runner, 'obstacle', 'sprinklers'))).toEqual({ obstacle: 'sprinkler' });
    expect(propModels(withLabel(runner, 'obstacle', 'deadlines'))).toEqual({});
  });

  // P39 T9: věc z věty se kreslí svým jménem v každé roli; primitiv (bodák, trubka, útes) jen bez jména z věty.
  it('draws every hazard from its cast name and keeps the primitive only when the sentence names nothing', () => {
    expect(propModels(withLabel(platform, 'spikes', 'animals')).spikes).toBe('dog');
    expect(propModels(withLabel(flap, 'pipe', 'trees')).pipe).toBe('oak-tree');
    const voyage = (cast: GenreSpec['cast']): GameSpecV1 => compileGenre({ genre: 'voyage', mode: 'race', hero: 'boat', setting: 'river', ...(cast === undefined ? {} : { cast }) } as GenreSpec);
    expect(propModels(voyage([{ label: 'crocodiles', does: 'avoid' }])).hazard).toBe('gen3d-crocodile');
    // Výchozí nástraha žánru zůstane primitivem jádra.
    expect(propModels(platform as GameSpecV1).spikes).toBeUndefined();
    expect(propModels(flap as GameSpecV1).pipe).toBeUndefined();
    expect(propModels(voyage(undefined)).hazard).toBeUndefined();
  });

  it('a named thing without its own model takes the nearest model, never the robot or the spike', () => {
    expect(enemyModel(withLabel(shooter, 'enemy', 'animals'))).toBe('dog');
    // Vlk katalog nemá; „wolves“ → „wolf“ → blízký pes, ne robot ani bodák.
    expect(enemyModel(withLabel(shooter, 'enemy', 'wolves'))).toBe('dog');
    expect(propModels(withLabel(platform, 'spikes', 'wolves')).spikes).toBe('dog');
    // Nejbližší model pod prahem čtení (aligátor → krokodýl 0,55) jen jako poslední možnost před robotem.
    expect(enemyModel(withLabel(shooter, 'enemy', 'alligators'))).toBe('gen3d-crocodile');
    expect(propModels(withLabel(flap, 'pipe', 'alligators')).pipe).toBe('gen3d-crocodile');
    // Jméno, které tabulka nejbližších vůbec nezná, nechá výchozí model role.
    expect(enemyModel(withLabel(shooter, 'enemy', 'zorbles'))).toBe('robot');
  });

  it('a flappy bird is the bird, not the nest', () => {
    expect(modelOf('little bird', true)).toBe('bird');
  });

  it('props take only a direct catalog match, never a category or the core kind', () => {
    expect(propModels(withLabel(runner, 'coin', 'gems'))).toEqual({ coin: 'crystal' });
    // Kužel má od P46G vlastní model z gen3d, místo něj bedny: jádro role, žádný model navíc.
    expect(propModels(withLabel(runner, 'obstacle', 'wooden crates'))).toEqual({});
    expect(propModels(withLabel(runner, 'obstacle', 'wild badgers'))).toEqual({});
    expect(propModels(withLabel(throwGame, 'target', 'rubber ducks'))).toEqual({ target: 'rubber-duck' });
  });

  // P39 T14: terč střelnice nese věc z věty („collect coins, dodge ghosts and shoot bats“ dá na střelnici mince),
  // kreslí se jejím jménem jako nástrahy z T9 – i postavou a nejbližším modelem; holý terč žánru zůstane kotoučem.
  it('the shooter range draws its target from the cast name, the bare target stays a bullseye', () => {
    expect(propModels(withLabel(shooter, 'target', 'rubber ducks'))).toEqual({ target: 'rubber-duck' });
    expect(propModels(withLabel(shooter, 'target', 'coin')).target).toBe('coin');
    expect(propModels(withLabel(shooter, 'target', 'ghosts')).target).toBe('ghost');
    // Třída postav jako u nástrah T9: „angry mech“ katalog nemá, kreslí ho robot, ne kotouč.
    expect(propModels(withLabel(shooter, 'target', 'angry mech')).target).toBe('robot');
    expect(propModels(shooter as GameSpecV1).target).toBeUndefined();
  });

  // P27A T4: soupeř souboje a závodu z popisku – jen model, který popisek jmenuje, žádná kategorie.
  it('names the duel and race rival from its label, honestly', () => {
    expect(propModels(withLabel(duel, 'rival', 'fox'))).toEqual({ rival: 'fox' });
    // Klokan má od P30B T4 vlastní model; vombata katalog nemá – kategorie „zvíře“ by nakreslila lišku, soupeř zůstane postavou z primitiv.
    expect(propModels(withLabel(duel, 'rival', 'kangaroo'))).toEqual({ rival: 'kangaroo' });
    expect(propModels(withLabel(duel, 'rival', 'wombat'))).toEqual({});
    expect(propModels(withLabel(steer, 'rival', 'rival plane'))).toEqual({ rival: 'plane' });
    // Soupeř závodu je vozidlo; zvíře jako auto neřídí.
    expect(propModels(withLabel(steer, 'rival', 'fox'))).toEqual({});
    expect(propModels(withLabel(steer, 'rival', 'rival car'))).toEqual({});
  });

  // Šablona střelnice a hodu (remix uložené hry, P32B T2) zapíše jméno z věty do role, kterou scéna kreslí.
  it.each([
    ['shoot the zombies in the mall', (spec: GameSpecV1) => enemyModel(spec), 'cc0-zombie'],
    ['space shooter against asteroids', (spec: GameSpecV1) => spec.roles.find((role) => role.id === 'enemy')?.label, 'asteroid'],
    ['throw balls at rubber ducks', (spec: GameSpecV1) => propModels(spec).target, 'rubber-duck'],
  ])('template sentence %s reaches the scene', (sentence, read, expected) => {
    expect(read(legacyDraft(sentence))).toBe(expected);
  });

  // Návrh ze slov musí jméno z věty do role zapsat, jinak scéna nemá co vybrat.
  it.each([
    ['a runner dodging traffic cones and collecting gems', (spec: GameSpecV1) => propModels(spec).coin, 'crystal'],
    ['a cat running and dodging dogs', (spec: GameSpecV1) => `${heroModel(spec)}|${propModels(spec).obstacle}`, 'rigged:pet-cat|dog'],
  ])('sentence %s reaches the scene', (sentence, read, expected) => {
    expect(read(draftGameSpec(sentence))).toBe(expected);
  });

  // Nález T11: místo bez předložky se v návrhu ztratilo a scéna zůstala na louce.
  it.each([
    ['flappy bird but underwater', 'underwater'],
    ['throw snowballs at kids from a snow fort', 'snow'],
  ])('sentence %s keeps its place (%s)', (sentence, look) => {
    expect(lookOf(draftGameSpec(sentence).theme)).toBe(look);
  });

  // P26B T6: lidská role s tagem riggované postavy dostane postavu s klipy, jinak se nic nemění.
  // P32C T4: kočka a tučňák mají animovanou postavu z Kenney Cube Pets; corgi zůstává model katalogu.
  it.each([
    ['a knight running and jumping over hurdles', 'rigged:knight'],
    ['a wizard running through the forest', 'rigged:mage'],
    ['a cat running and dodging dogs', 'rigged:pet-cat'],
    // P26D T1: slovo žánru za postavou postavu nesmaže.
    ['A corgi runner collecting bones', 'cc0-corgi'],
    ['a penguin runner', 'rigged:pet-penguin'],
  ])('sentence %s casts %s as the hero', (sentence, model) => {
    expect(heroModel(draftGameSpec(sentence))).toBe(model);
  });

  // Návrh ze slov „a cat runner“ kočku do popisku nezapíše (dá výchozího rytíře), takže pravidlo hlavy fráze se měří na popisku.
  it.each([
    ['cat runner', 'rigged:pet-cat'],
    ['knight', 'rigged:knight'],
    ['brave little girl', 'rigged:girl-a'],
    ['sock', 'cc0-sock'],
    ['stapler', 'explorer'],
  ])('hero label %s → %s', (label, model) => {
    expect(heroModel(withLabel(runner, 'player', label))).toBe(model);
  });

  it.each([
    ['skeleton warriors', 'rigged:skeleton-warrior'],
    ['angry pirates', 'rigged:rogue'],
    ['zombies', 'cc0-zombie'], // kostlivec není zombie – zombie má vlastní model
    ['cardboard robots', 'robot'],
  ])('enemy label %s → %s', (label, model) => {
    expect(enemyModel(withLabel(shooter, 'enemy', label))).toBe(model);
  });

  it('a rigged pick resolves to a manifest character whose GLB is on disk', () => {
    const character = riggedCharacter(heroModel(draftGameSpec('a knight jumping over lava')));
    expect(character?.clips).toMatchObject({ idle: expect.any(String), run: expect.any(String), jump: expect.any(String) });
    expect(existsSync(join(process.cwd(), 'public', character!.path))).toBe(true);
    expect(riggedCharacter('knight')).toBeUndefined();
  });

  it('every model a label can pick has a GLB on disk', () => {
    for (const id of ['dog', 'robot', 'goblin', 'crystal', 'rubber-duck', 'aquarium', 'hurdle']) {
      expect(existsSync(join(process.cwd(), 'public', modelPath(id))), id).toBe(true);
    }
  });
});
