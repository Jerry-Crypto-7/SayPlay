/**
 * Slovník akcí hrdiny P52 (T3): slovesa, která P47B a dev sada P52 minuly
 * („darts“, „veers“, „smacks“, štít, který hrdina zvedne), a past slovesa
 * nepřítele („enemy turrets fire at…“, „as hunters shoot…“). Past vypadá jako
 * správně přečtené sloveso – hra pak dá hrdinovi zbraň, kterou věta dala jinému.
 */
import { describe, expect, it } from 'vitest';

import { pickControl, saidAbilities } from '@/play/draft/controls';

const said = (text: string): string[] => saidAbilities(text.toLowerCase()).slice(0, 2);
const addons = (text: string): readonly string[] => pickControl(text.toLowerCase())?.addons ?? [];

describe('P52 hero verbs', () => {
  it('reads darting and veering as dash', () => {
    expect(said('a hummingbird darts between the flowers to escape the hornets')).toEqual(['dash']);
    expect(said('A sports car veers around the traffic cones on a rainy highway.')).toEqual(['dash']);
    expect(said('a swallow darting past the hawks over the lake')).toEqual(['dash']);
  });

  it('reads smacking as strike and a raised shield or force field as shield', () => {
    expect(said('A kid catches cupcakes in a box on the porch and smacks the flies away.')).toEqual(['strike']);
    expect(said('A turret gunner raises a force field and shoots down the incoming drones.')).toEqual(['shield', 'shoot']);
    expect(said('A courier runs across the rooftops holding up a shield against the falling bricks.')).toEqual(['shield']);
  });

  it('keeps the hero shooting at a thing that is not the protagonist', () => {
    expect(said('kids shoot at the cans on the fence')).toEqual(['shoot']);
    expect(said('a cowboy shoots at a bottle on the wall')).toEqual(['shoot']);
  });
});

describe('P52 enemy verbs', () => {
  it('gives the hero nothing when the enemy fires, shoots or grabs at the protagonist', () => {
    expect(said('enemy turrets fire at a little robot crossing the factory floor')).toEqual([]);
    expect(said('Guards shoot at you while you escape across the prison yard.')).toEqual([]);
    expect(said('hawks grab at a field mouse running through the wheat')).toEqual([]);
    expect(said('A penguin waddles home while the seals snap at its tail.')).toEqual([]);
  });

  it('adds no shooting when only someone in a while/as clause shoots or blasts', () => {
    expect(said('a bunny hops across the meadow as hunters shoot arrows at it')).toEqual([]);
    expect(addons('a bunny hops across the meadow as hunters shoot arrows at it')).not.toContain('shoot');
    expect(addons('A little boat sails through the storm as cannons blast from the shore.')).not.toContain('shoot');
    expect(addons('a pilot races a jet through the canyon while the drones blast at him')).not.toContain('shoot');
  });

  it('still adds shooting when the hero does it', () => {
    expect(addons('a pilot races a jet through the canyon and blasts the drones')).toContain('shoot');
    expect(addons('a bunny hops across the meadow and shoots carrots at the foxes')).toContain('shoot');
  });
});
