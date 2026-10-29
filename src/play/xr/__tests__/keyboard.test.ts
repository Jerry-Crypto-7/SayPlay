import { describe, expect, it } from 'vitest';

import { KEY_COLUMNS, KEY_ROWS, type KeyPress, typed } from '../keyboard';

const LIMIT = 140;
const char = (value: string): KeyPress => ({ kind: 'char', char: value });
const SPACE: KeyPress = { kind: 'space' };
const DELETE: KeyPress = { kind: 'delete' };

/** Stisky za sebou od prázdné věty. */
const type = (keys: readonly KeyPress[], from = '', limit = LIMIT): string => keys.reduce((text, key) => typed(text, key, limit), from);

describe('VR keyboard layout', () => {
  it('is QWERTY under a row of digits, ten keys a row', () => {
    expect(KEY_ROWS[0]).toBe('1234567890');
    expect(KEY_ROWS[1]).toBe('qwertyuiop');
    expect(KEY_ROWS[2]?.startsWith('asdfghjkl')).toBe(true);
    expect(KEY_ROWS[3]?.startsWith('zxcvbnm')).toBe(true);
    for (const row of KEY_ROWS) expect(row, row).toHaveLength(KEY_COLUMNS);
  });

  it('has every letter and digit exactly once, and no key twice', () => {
    const keys = KEY_ROWS.join('');
    expect(new Set(keys).size).toBe(keys.length);
    for (const needed of 'abcdefghijklmnopqrstuvwxyz0123456789') expect(keys, needed).toContain(needed);
    // Interpunkce z vět karet nápadů a ze vzoru věty („farmer's dog“).
    for (const mark of [',', '.', "'"]) expect(keys).toContain(mark);
  });
});

describe('typed', () => {
  it('appends letters and capitalises the first one', () => {
    expect(type([char('c'), char('a'), char('t')])).toBe('Cat');
    expect(type([char('s')], 'A cat')).toBe('A cats');
  });

  it('never starts with a space and never puts two in a row', () => {
    expect(type([SPACE])).toBe('');
    expect(type([char('a'), SPACE, SPACE, char('b')])).toBe('A b');
    expect(type([SPACE], 'A cat ')).toBe('A cat ');
  });

  it('deletes the last character, down to empty and no further', () => {
    expect(type([DELETE], 'A cat')).toBe('A ca');
    expect(type([char('a'), SPACE, DELETE])).toBe('A');
    expect(type([DELETE, DELETE])).toBe('');
  });

  it('stops at the sentence limit for letters and spaces, but delete still works', () => {
    const full = 'x'.repeat(LIMIT);
    expect(typed(full, char('y'), LIMIT)).toBe(full);
    expect(typed(full, SPACE, LIMIT)).toBe(full);
    expect(typed(full, DELETE, LIMIT)).toHaveLength(LIMIT - 1);
    expect(type([char('a'), char('b'), char('c')], '', 2)).toBe('Ab');
  });
});
