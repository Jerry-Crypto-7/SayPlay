/**
 * Přezdívka z obrazovky výsledku (P44B T10). Uložené jméno, které se v žebříčku neukáže, vypadá
 * jako hotové – proto se žebříček po uložení čte znovu a nikdy z cache prohlížeče. Řádek
 * „Playing as … · Change“ je papírový: rajčatová akce výsledku zůstává jedna (Dare).
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { RunFacts } from '../PostRun';
import type { RemixJob } from '../RemixBox';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

const { fetchBoard, rememberDare } = await import('../board-client');
const { fetchMe, knownName, NAME_REFUSED, NAME_RULE, saveNickname } = await import('../me-client');
const { NicknameSheet } = await import('../NicknameSheet');
const { PostRun } = await import('../PostRun');

const reply = (status: number, body: unknown = {}) => vi.fn(async () => Response.json(body, { status }));
const offline = vi.fn(async () => {
  throw new TypeError('offline');
});
const asFetch = (fetcher: unknown): typeof fetch => fetcher as typeof fetch;
const initOf = (fetcher: ReturnType<typeof vi.fn>): RequestInit => (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
const text = (html: string): string => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '');

describe('fetchMe', () => {
  it('reads the nickname fresh; names switched off (503) are remembered, a passing failure is not', async () => {
    const ok = reply(200, { nickname: 'Swift Otter' });
    expect(await fetchMe(asFetch(ok))).toBe('Swift Otter');
    expect(ok).toHaveBeenCalledWith('/api/play/me', expect.objectContaining({ cache: 'no-store' }));
    expect(knownName()).toBe('Swift Otter');

    expect(await fetchMe(asFetch(reply(429)))).toBeNull();
    expect(await fetchMe(asFetch(offline))).toBeNull();
    expect(knownName()).toBe('Swift Otter');

    expect(await fetchMe(asFetch(reply(503)))).toBeNull();
    expect(knownName()).toBeNull();
  });
});

describe('saveNickname', () => {
  it('sends the name as JSON with PUT and keeps what the server saved', async () => {
    const ok = reply(200, { nickname: 'Ada' });
    expect(await saveNickname('  Ada ', asFetch(ok))).toEqual({ ok: true, nickname: 'Ada' });
    const init = initOf(ok);
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ nickname: '  Ada ' });
    expect(knownName()).toBe('Ada');
  });

  it('says what to fix in voice copy; 503 hides the line instead of an error', async () => {
    expect(await saveNickname('A', asFetch(reply(400)))).toEqual({ ok: false, error: NAME_RULE });
    expect(NAME_RULE).toBe('Use 2–20 letters or numbers.');
    expect(await saveNickname('Admin', asFetch(reply(422)))).toEqual({ ok: false, error: NAME_REFUSED });
    expect(NAME_REFUSED).toBe("We can't use that name. Try another one.");
    expect(await saveNickname('Ada', asFetch(reply(503)))).toEqual({ ok: false, error: null });
    for (const failed of [reply(429), reply(403), offline, reply(200, { nope: 1 })]) {
      const saved = await saveNickname('Ada', asFetch(failed));
      expect(saved.ok).toBe(false);
      expect(saved.ok === false && saved.error).toMatch(/^We couldn't save your name\./);
    }
  });
});

describe('fetchBoard after a rename', () => {
  it('never reads the leaderboard from the browser cache, so a saved name shows up at once', async () => {
    const ok = reply(200, { rows: [] });
    await fetchBoard('v1', asFetch(ok));
    expect(initOf(ok).cache).toBe('no-store');
  });
});

describe('NicknameSheet', () => {
  it('is a kit sheet with the name field, filled with the current name, and one Save action', () => {
    const html = renderToStaticMarkup(createElement(NicknameSheet, { nickname: 'Swift Otter', onDone: () => undefined, onClose: () => undefined }));
    expect(html).toMatch(/class="sp-sheet[^"]*"/);
    expect(text(html)).toContain('Your name on the board');
    expect(html).toMatch(/<input[^>]*value="Swift Otter"/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Save<\/button>/);
    expect(html.match(/data-variant="primary"/g)).toHaveLength(1);
    expect(html).not.toMatch(/#[0-9a-f]{6}\b/i);
  });
});

describe('PostRun names who is playing', () => {
  const job: RemixJob = { view: { kind: 'idle' }, sent: '', submit: () => undefined };
  const won: RunFacts = { won: true, tick: 246, hz: 20, survive: false, goal: { count: 5, need: 5, label: 'collected' }, extra: [] };
  const dareId = '7'.repeat(32);
  const card = (facts: RunFacts, extra: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(createElement(PostRun, { versionId: 'v1', remix: job, facts, onReplay: () => undefined, dare: { state: 'ready', dareId }, ...extra }));

  it('under a verified win: a paper "Playing as … · Change" line, never a second primary action', async () => {
    await fetchMe(asFetch(reply(200, { nickname: 'Swift Otter' })));
    rememberDare(dareId, { board: { place: 1, of: 1 }, beat: null });
    const html = card(won);
    expect(text(html)).toContain('Playing as Swift Otter · Change');
    expect(html).toMatch(/<button[^>]*data-variant="link"[^>]*>Change<\/button>/);
    expect(html.match(/data-variant="primary"/g)).toHaveLength(1);
    expect(html.indexOf('play-playing-as')).toBeLessThan(html.indexOf('play-result-actions'));
  });

  it('not after a loss, in the offline demo, before the run is verified, or when names are off', async () => {
    expect(card({ ...won, won: false })).not.toContain('Playing as');
    expect(card(won, { offline: true })).not.toContain('Playing as');
    expect(card(won, { dare: { state: 'pending' } })).not.toContain('Playing as');
    await fetchMe(asFetch(reply(503)));
    expect(card(won)).not.toContain('Playing as');
  });
});
