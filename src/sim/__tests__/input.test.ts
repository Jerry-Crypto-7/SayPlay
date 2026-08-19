/**
 * Klávesa → `Intent`, a to bez prohlížeče.
 *
 * Celý smysl téhle vrstvy je, že hra klávesnici **nevidí**. Vidí záměr, takže
 * jde stejný vstup poslat z testu, ze scriptované stopy i z prstu na klávese, a
 * pokaždé to projde touž cestou. Kdyby si smyčka četla `event.key` sama, tenhle
 * soubor by nešlo napsat vůbec.
 *
 * **Druhá polovina souboru hlídá vědomou duplikaci.** Fallback nesmí importovat
 * z jádra (axiom architektonické nezávislosti, `plans/P2-fallback-tri-hry.md`);
 * `npm run prove:fallback` to dokazuje studeným buildem ve stromu, ze kterého
 * bylo jádro odstraněno, a AC T202 skenuje `src/fallback/**` na řetězce s
 * cestami do jádra. Mapa kláves proto existuje dvakrát. Duplikace sama je v
 * pořádku a repozitář ji dělá i jinde (generátor streamů ve `fallback/loop.ts`);
 * co v pořádku není, je nechat obě kopie tiše se rozejít. Tenhle test je to
 * jediné místo, které smí sáhnout na obě — leží mimo `src/fallback/**`, takže
 * ho ten sken nezakazuje.
 */

import { describe, expect, it } from 'vitest';

import { intentFromKey as fallbackIntent, BOUND_KEYS as FALLBACK_KEYS } from '../../fallback/input';
import { BOUND_KEYS, intentFromKey } from '../input';

describe('intentFromKey', () => {
  it('šipky dávají pohyb o jedno pole ve čtyřsousedství', () => {
    expect(intentFromKey('ArrowRight')).toEqual({ kind: 'move', dx: 1, dy: 0 });
    expect(intentFromKey('ArrowLeft')).toEqual({ kind: 'move', dx: -1, dy: 0 });
    expect(intentFromKey('ArrowUp')).toEqual({ kind: 'move', dx: 0, dy: 1 });
    expect(intentFromKey('ArrowDown')).toEqual({ kind: 'move', dx: 0, dy: -1 });
  });

  it('WASD dělá totéž co šipky', () => {
    expect(intentFromKey('d')).toEqual(intentFromKey('ArrowRight'));
    expect(intentFromKey('a')).toEqual(intentFromKey('ArrowLeft'));
    expect(intentFromKey('w')).toEqual(intentFromKey('ArrowUp'));
    expect(intentFromKey('s')).toEqual(intentFromKey('ArrowDown'));
  });

  it('velké písmeno je tatáž klávesa — se Shiftem se hra nesmí zaseknout', () => {
    expect(intentFromKey('D')).toEqual(intentFromKey('d'));
    expect(intentFromKey('W')).toEqual(intentFromKey('w'));
  });

  it('nevázaná klávesa nedává záměr, ne prázdný pohyb', () => {
    // `{dx:0,dy:0}` by prošlo do `advance` jako pohyb a spotřebovalo tik.
    // `null` je odpověď „tohle není vstup do hry", což je něco jiného.
    expect(intentFromKey('Enter')).toBeNull();
    expect(intentFromKey('F5')).toBeNull();
    expect(intentFromKey(' ')).toBeNull();
    expect(intentFromKey('')).toBeNull();
  });

  it('žádná vázaná klávesa nedává nulový posun', () => {
    for (const key of BOUND_KEYS) {
      const intent = intentFromKey(key);
      expect(intent, key).not.toBeNull();
      expect(intent!.kind).toBe('move');
      const move = intent as { dx: number; dy: number };
      expect(Math.abs(move.dx) + Math.abs(move.dy), `${key} musí hýbat právě o jedno pole`).toBe(1);
    }
  });
});

describe('kopie ve fallbacku se nesmí rozejít s jádrem', () => {
  it('obě mapy vážou tytéž klávesy', () => {
    expect([...FALLBACK_KEYS].sort()).toEqual([...BOUND_KEYS].sort());
  });

  it('a na každé z nich dávají tentýž záměr', () => {
    for (const key of BOUND_KEYS) {
      expect(fallbackIntent(key), key).toEqual(intentFromKey(key));
    }
  });

  it('a shodují se i na tom, co záměr nedává', () => {
    for (const key of ['Enter', 'F5', ' ', '', 'Escape', 'Tab']) {
      expect(fallbackIntent(key), key).toEqual(intentFromKey(key));
    }
  });
});
