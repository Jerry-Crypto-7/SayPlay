/**
 * Rapier se načítá jen pro hru s fyzikou (P29A T13). Fyzika natažená do každé
 * hry by zpomalila první snímek, aniž by cokoli spadlo – proto pin: hra bez
 * fyziky modul nenačte, hra s ní bez načtení neprojde a po něm ano.
 *
 * Hra s fyzikou ukáže scénu hned a Rapier dotéká souběžně (P32D T4). Hodiny
 * relace do jeho načtení stojí (`holdUntilRapier`): předčasný tik by na
 * obrazovce vypadal jako běžící hra a v prvním snímku spadl na výjimce jádra.
 *
 * Pořadí testů je záměrné: načtený Rapier zůstává v procesu do konce souboru.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createArcadeSession, TICK_MS } from '@/components/play/arcade/session';
import type { GameSpecV1 } from '@/play/spec';

import { arcadeWorldOf, compileArcade, preloadPhysics, specNeedsPhysics } from '../compile';
import { BODY, FLAG, HEADER_SIZE, BODY_STRIDE } from '../contract';
import { worldHasPhysics } from '../kernel';
import { holdUntilRapier, loadRapier, prefetchRapier, rapierIfLoaded } from '../physics/world';

const fixture = (name: string): GameSpecV1 => JSON.parse(readFileSync(new URL(`../__fixtures__/rules/${name}.json`, import.meta.url), 'utf8')) as GameSpecV1;

const plain = fixture('throw-rock');
const physical: GameSpecV1 = { ...plain, things: [{ role: 'rock', physics: true }] };

const physicalWorld = (() => {
  const made = arcadeWorldOf(physical, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
})();
// Relace, kterou scéna kreslí od prvního snímku, ještě než je Rapier načtený.
const held = holdUntilRapier(createArcadeSession(physicalWorld));

describe('Rapier loads only for games with physics', () => {
  it('a game without physics compiles and never loads Rapier', async () => {
    expect(specNeedsPhysics(plain)).toBe(false);
    await preloadPhysics(plain, loadRapier);
    prefetchRapier(false);
    const compiled = compileArcade(plain, 1);
    expect(compiled.ok).toBe(true);
    expect(rapierIfLoaded()).toBeNull();
  });

  it('a physics game on screen before Rapier holds tick 0 instead of crashing its first frame', () => {
    // Bez držení by první snímek scény udělal tik a jádro by na chybějícím Rapieru spadlo.
    expect(() => createArcadeSession(physicalWorld).advance(100)).toThrow(/loadRapier/);
    held.press(1);
    for (let frame = 0; frame < 30; frame += 1) expect(held.advance(100)).toBe(0);
    held.stepOnce();
    expect(held.snapshot()).toMatchObject({ tick: 0, runState: 'running' });
    expect(held.inputs()).toEqual([]);
    expect(rapierIfLoaded()).toBeNull();
  });

  it('a rule thing with physics:true becomes a physics body', () => {
    const made = arcadeWorldOf(physical, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(worldHasPhysics(made.world)).toBe(true);
    const flags: number[] = [];
    for (let at = HEADER_SIZE + BODY.flags; at < made.world.initial.length; at += BODY_STRIDE) flags.push(made.world.initial[at] as number);
    expect(flags.filter((f) => (f & FLAG.physics) !== 0)).toHaveLength(1);
    const without = arcadeWorldOf(plain, 1);
    expect(without.ok && worldHasPhysics(without.world)).toBe(false);
  });

  it('a physics game refuses to compile before preloadPhysics and compiles after it', async () => {
    expect(specNeedsPhysics(physical)).toBe(true);
    const early = compileArcade(physical, 1);
    expect(early.ok).toBe(false);
    expect(!early.ok && early.issues.join()).toMatch(/physics engine is not loaded/);
    await preloadPhysics(physical, loadRapier);
    expect(rapierIfLoaded()).not.toBeNull();
    const compiled = compileArcade(physical, 1);
    expect(compiled.ok ? 'ok' : `${compiled.reason}: ${compiled.issues.join('; ')}`).toBe('ok');
  });

  it('the held game starts on the first frame after Rapier, without a burst of the waited time', () => {
    // Stisk z čekání padne do tiku 0; čekání se do hodin nepřičetlo, takže jeden snímek = jeden tik.
    held.advance(TICK_MS);
    expect(held.snapshot().tick).toBe(1);
    expect(held.inputs()).toEqual([{ tick: 0, buttons: 1, axis: 0 }]);
    held.advance(TICK_MS);
    expect(held.snapshot().tick).toBe(2);
  });
});
