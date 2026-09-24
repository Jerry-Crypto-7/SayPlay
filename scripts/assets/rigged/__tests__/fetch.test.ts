import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import sources from '../sources.json';
import { fetchSource, licenseMatches } from '../fetch.mjs';

const CC0_TEXT = 'License: (Creative Commons Zero, CC0)\nhttp://creativecommons.org/publicdomain/zero/1.0/';
const GLB = Buffer.from('glTF-fake-bytes');

/** Falešná síť: adresa → tělo; neznámá adresa = 404. */
function net(routes: Record<string, string | Uint8Array>): typeof fetch {
  return (async (url: string | URL) => {
    const body = routes[String(url)];
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body as BodyInit);
  }) as typeof fetch;
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'rigged-'));
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

const github = (over: Record<string, unknown> = {}) => ({
  id: 'pack',
  name: 'Pack',
  author: 'Someone',
  kind: 'github',
  license: 'CC0-1.0',
  page: 'https://example.test/pack',
  licenseUrl: 'https://example.test/LICENSE.txt',
  files: ['https://example.test/Knight.glb'],
  ...over,
});

describe('stažení riggovaných postav (P26B T3)', () => {
  it('CC0 balík stáhne soubory, uloží text licence a zapíše sha256', async () => {
    const record = await fetchSource(github(), { fetch: net({ 'https://example.test/LICENSE.txt': CC0_TEXT, 'https://example.test/Knight.glb': GLB }), cacheDir });
    if (record.status !== 'fetched') throw new Error(record.reason);
    expect(record.license).toBe('CC0-1.0');
    expect(readFileSync(record.licenseFile, 'utf8')).toBe(CC0_TEXT);
    const [file] = record.files;
    expect(file.url).toBe('https://example.test/Knight.glb');
    expect(file.sha256).toBe(createHash('sha256').update(GLB).digest('hex'));
    expect(readFileSync(file.path)).toEqual(GLB);
  });

  it('licence mimo CC0-1.0 / CC-BY-4.0 se odmítne a nic se nestáhne', async () => {
    const record = await fetchSource(github({ license: 'CC-BY-NC-4.0' }), { fetch: net({ 'https://example.test/LICENSE.txt': 'Attribution-NonCommercial 4.0', 'https://example.test/Knight.glb': GLB }), cacheDir });
    expect(record.status).toBe('skipped');
    expect(record.reason).toMatch(/licen[cs]e/i);
    expect(existsSync(join(cacheDir, 'pack', 'Knight.glb'))).toBe(false);
  });

  it('text licence, který deklaraci neodpovídá, balík odmítne', async () => {
    const record = await fetchSource(github(), { fetch: net({ 'https://example.test/LICENSE.txt': 'All rights reserved. Personal use only.', 'https://example.test/Knight.glb': GLB }), cacheDir });
    expect(record.status).toBe('skipped');
    expect(existsSync(join(cacheDir, 'pack', 'Knight.glb'))).toBe(false);
  });

  it('chybějící text licence balík odmítne', async () => {
    const record = await fetchSource(github(), { fetch: net({ 'https://example.test/Knight.glb': GLB }), cacheDir });
    expect(record.status).toBe('skipped');
  });

  it('licenseMatches pozná CC0 i CC BY 4.0 a nic jiného', () => {
    expect(licenseMatches('CC0-1.0', CC0_TEXT)).toBe(true);
    expect(licenseMatches('CC0-1.0', 'CC0 1.0 Universal')).toBe(true);
    expect(licenseMatches('CC-BY-4.0', 'Creative Commons Attribution 4.0 International')).toBe(true);
    expect(licenseMatches('CC-BY-4.0', 'Attribution-NonCommercial 4.0 International')).toBe(false);
    expect(licenseMatches('CC0-1.0', 'Creative Commons Attribution 4.0')).toBe(false);
  });

  it('Kenney: zip ze stránky, licence ze zipu, bere jen modely', async () => {
    const zip = zipSync({ 'License.txt': strToU8('Creative Commons Zero, CC0\nhttp://creativecommons.org/publicdomain/zero/1.0/'), 'Models/GLB format/character-a.glb': new Uint8Array(GLB), 'Preview.png': strToU8('png') });
    const page = '<a href="https://kenney.nl/media/pages/assets/mini/abc-1/kenney_mini.zip">Download</a>';
    const record = await fetchSource(
      { id: 'kenney-mini', name: 'Mini', author: 'Kenney', kind: 'kenney', license: 'CC0-1.0', page: 'https://kenney.nl/assets/mini' },
      { fetch: net({ 'https://kenney.nl/assets/mini': page, 'https://kenney.nl/media/pages/assets/mini/abc-1/kenney_mini.zip': zip }), cacheDir },
    );
    if (record.status !== 'fetched') throw new Error(record.reason);
    expect(record.files.map((file) => file.path.replace(/\\/g, '/').split('/').pop())).toEqual(['character-a.glb']);
    expect(readFileSync(record.licenseFile, 'utf8')).toMatch(/CC0/);
  });

  it('Kenney bez odkazu na zip a zdroj „skip“ skončí skipped s důvodem', async () => {
    const noZip = await fetchSource({ id: 'k', name: 'K', author: 'Kenney', kind: 'kenney', license: 'CC0-1.0', page: 'https://kenney.nl/assets/k' }, { fetch: net({ 'https://kenney.nl/assets/k': '<html></html>' }), cacheDir });
    expect(noZip).toMatchObject({ status: 'skipped' });
    const skip = await fetchSource({ id: 's', name: 'S', author: 'Q', kind: 'skip', license: 'CC0-1.0', page: 'https://x.test', skipReason: 'needs a click' }, { fetch: net({}), cacheDir });
    expect(skip).toMatchObject({ status: 'skipped', reason: 'needs a click' });
  });

  it('seznam zdrojů deklaruje jen povolené licence', () => {
    for (const source of sources.sources) expect(['CC0-1.0', 'CC-BY-4.0']).toContain(source.license);
  });
});
