/**
 * Rapier se načítá jen pro hru s fyzikou (P29A T13). Fyzika natažená do každé
 * hry by zpomalila první snímek, aniž by cokoli spadlo – proto pin: hra bez
 * fyziky modul nenačte, hra s ní bez načtení neprojde a po něm ano.
 *
 * Pořadí testů je záměrné: načtený Rapier zůstává v procesu do konce souboru.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { GameSpecV1 } from '@/play/spec';

import { arcadeWorldOf, compileArcade, preloadPhysics, specNeedsPhysics } from '../compile';
import { BODY, FLAG, HEADER_SIZE, BODY_STRIDE } from '../contract';
import { worldHasPhysics } from '../kernel';
import { loadRapier, rapierIfLoaded } from '../physics/world';

const fixture = (name: string): GameSpecV1 => JSON.parse(readFileSync(new URL(`../__fixtures__/rules/${name}.json`, import.meta.url), 'utf8')) as GameSpecV1;

const plain = fixture('throw-rock');
const physical: GameSpecV1 = { ...plain, things: [{ role: 'rock', physics: true }] };

describe('Rapier loads only for games with physics', () => {
  it('a game without physics compiles and never loads Rapier', async () => {
    expect(specNeedsPhysics(plain)).toBe(false);
    await preloadPhysics(plain, loadRapier);
    const compiled = compileArcade(plain, 1);
    expect(compiled.ok).toBe(true);
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
});
