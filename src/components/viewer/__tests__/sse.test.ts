/**
 * Dekodér `text/event-stream`.
 *
 * Testuje se **rozpad rámce přes hranici kusu**, ne jen šťastná cesta. Rámec
 * podaný vcelku projde i implementací, která si nic nepamatuje mezi voláními —
 * a přesně taková v provozu ztratí každou zprávu, která se nevejde do jednoho
 * síťového kusu. Ve zmrazeném korpusu se to projeví jako chybějící fáze, tedy
 * jako údajně rychlejší emise.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SseDecoder, streamEmission } from '../sse';

describe('SseDecoder', () => {
  it('přečte rámec s událostí i daty', () => {
    expect(new SseDecoder().push('event: progress\ndata: {"phase":"schema"}\n\n')).toEqual([
      { event: 'progress', data: '{"phase":"schema"}' },
    ]);
  });

  it('poskládá rámec rozpadlý uprostřed řádku', () => {
    const decoder = new SseDecoder();
    expect(decoder.push('event: progress\ndata: {"pha')).toEqual([]);
    expect(decoder.push('se":"witness"}\n')).toEqual([]);
    expect(decoder.push('\n')).toEqual([{ event: 'progress', data: '{"phase":"witness"}' }]);
  });

  it('přečte dva rámce z jednoho kusu a zbytek si nechá', () => {
    const decoder = new SseDecoder();
    const frames = decoder.push('data: a\n\ndata: b\n\ndata: c');
    expect(frames).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
    expect(decoder.push('\n\n')).toEqual([{ event: 'message', data: 'c' }]);
  });

  it('bere CRLF stejně jako LF', () => {
    expect(new SseDecoder().push('event: result\r\ndata: {}\r\n\r\n')).toEqual([
      { event: 'result', data: '{}' },
    ]);
  });

  it('spojí víc datových řádků novým řádkem', () => {
    expect(new SseDecoder().push('data: první\ndata: druhý\n\n')).toEqual([
      { event: 'message', data: 'první\ndruhý' },
    ]);
  });

  it('přeskočí komentář a rámec bez dat nevydá', () => {
    // Server jím drží spojení naživu. Kdyby z něj vznikl rámec, viewer by
    // vypsal fázi, která se nestala.
    expect(new SseDecoder().push(': keep-alive\n\n')).toEqual([]);
  });

  it('ubere jednu mezeru za dvojtečkou, další ne', () => {
    expect(new SseDecoder().push('data:  dvě mezery\n\n')).toEqual([
      { event: 'message', data: ' dvě mezery' },
    ]);
  });

  it('bez `event:` je událost `message`', () => {
    expect(new SseDecoder().push('data: x\n\n')).toEqual([{ event: 'message', data: 'x' }]);
  });
});

describe('streamEmission', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('odmítnutý požadavek je chyba, ne emise bez výsledku', async () => {
    // Chybové stavy odcházejí jako JSON, ne jako proud rámců. Bez kontroly stavu
    // se dekóduje nula rámců a volající dostane `result: null` — tedy „emise
    // doběhla a nic nevrátila" místo „server požadavek odmítl".
    vi.stubGlobal('fetch', async () => new Response('{"error":{"code":"PAYLOAD_TOO_LARGE"}}', { status: 413 }));

    await expect(streamEmission('C01')).rejects.toThrow(/HTTP 413/);
  });

  it('přečte fáze i verdikt z proudu', async () => {
    const frame = (event: string, data: string) => `event: ${event}\ndata: ${data}\n\n`;
    const body = [
      frame('progress', '{"phase":"requested","step":1}'),
      frame('progress', '{"phase":"emitted","step":2}'),
      frame('result', '{"outcome":"CERTIFIED"}'),
    ].join('');
    vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }));

    const seen: string[] = [];
    const stream = await streamEmission('C01', { onProgress: (step) => seen.push(step.phase) });

    expect(seen).toEqual(['requested', 'emitted']);
    expect(stream.result).toEqual({ outcome: 'CERTIFIED' });
  });
});
