/**
 * Klávesa → `Intent`, a to bez prohlížeče.
 *
 * Celý smysl téhle vrstvy je, že hra klávesnici **nevidí**. Vidí záměr, takže
 * jde stejný vstup poslat z testu, ze scriptované stopy i z prstu na klávese, a
 * pokaždé to projde touž cestou. Kdyby si smyčka četla `event.key` sama, tenhle
 * soubor by nešlo napsat vůbec.
 */

import { describe, expect, it } from 'vitest';

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
