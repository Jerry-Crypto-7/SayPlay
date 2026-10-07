import { describe, expect, it } from 'vitest';

import { defaultNickname, readNickname, shownNickname } from '../nickname';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'BBBBBBBBBBBBBBBBBBBBBB';

describe('defaultNickname', () => {
  it('is deterministic, two English words, and carries nothing of the id', () => {
    expect(defaultNickname(ID)).toBe(defaultNickname(ID));
    expect(defaultNickname(ID)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(defaultNickname(ID)).not.toContain(ID.slice(0, 4));
  });

  it('spreads ids over many names', () => {
    const names = new Set(Array.from({ length: 200 }, (_, i) => defaultNickname(`${String(i).padStart(22, 'x')}`)));
    expect(names.size).toBeGreaterThan(100);
    expect(defaultNickname(ID)).not.toBe(defaultNickname(OTHER));
  });
});

describe('readNickname', () => {
  it.each(['Ada', 'Bo', '  Bo  ', 'Žofie 7', 'neo_x.y-z', 'a'.repeat(20)])('accepts %j', (name) => {
    expect(readNickname(name)).toEqual({ ok: true, nickname: name.trim() });
  });

  it.each(['A', ' A ', 'a'.repeat(21), '', '<script>', 'a/b', 'Ada!', 'tab\there', 42, null, undefined, ['Ada']])('refuses the shape of %j', (name) => {
    expect(readNickname(name)).toEqual({ ok: false, reason: 'shape' });
  });

  it('counts characters, not UTF-16 units', () => {
    expect(readNickname('Ž'.repeat(20)).ok).toBe(true);
    expect(readNickname('Ž'.repeat(21)).ok).toBe(false);
  });

  it('refuses a name the PLAY moderation blocks', () => {
    expect(readNickname('make a bomb')).toEqual({ ok: false, reason: 'blocked' });
  });

  // T3a: urážka nebo cizí autorita na veřejném žebříčku vypadá jako jakékoli jiné jméno.
  it.each(['fuck', 'FuckYou 7', 'f.u.c.k', 'f u c k', 'Big_Shit', 'kurva', 'K-U-R-V-A', 'Píča', 'p.i.c.a', 'čurák', 'Kokot99', 'sračka', 'Zmrd', 'nigger', 'Hitler', 'ass', 'a s s'])('blocks the insult %j', (name) => {
    expect(readNickname(name)).toEqual({ ok: false, reason: 'blocked' });
  });

  it.each(['admin', 'Admin 7', 'a.d.m.i.n', 'ADMIN_', 'SayPlay', 'Sayplay Team', 'say-play', 'moderator', 'Mod Erator', 'Official', 'OfficialAda', 'system', 'support', 'Ada Support'])('blocks the reserved name %j', (name) => {
    expect(readNickname(name)).toEqual({ ok: false, reason: 'blocked' });
  });

  it.each(['Badminton', 'Picasso', 'Grape', 'Bass', 'Cassandra', 'Peacock', 'Scott', 'Dickens', 'Sussex', 'Negroni'])('still accepts the innocent %j', (name) => {
    expect(readNickname(name)).toEqual({ ok: true, nickname: name });
  });
});

describe('shownNickname', () => {
  it('shows a stored name only while it still passes readNickname', () => {
    expect(shownNickname(ID, 'Ada')).toBe('Ada');
    expect(shownNickname(ID, null)).toBe(defaultNickname(ID));
    expect(shownNickname(ID, '<img src=x>')).toBe(defaultNickname(ID));
    expect(shownNickname(ID, 'make a bomb')).toBe(defaultNickname(ID));
  });

  it('replaces a stored insult or reserved name with the default (stored before T3a)', () => {
    expect(shownNickname(ID, 'K u r v a')).toBe(defaultNickname(ID));
    expect(shownNickname(ID, 'Sayplay Team')).toBe(defaultNickname(ID));
  });
});
