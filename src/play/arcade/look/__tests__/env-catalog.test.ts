/**
 * Knihovna panoramat (P29C T3). Chybějící soubor nebo licence by ve hře prošly
 * bez povšimnutí – obloha by jen zůstala plochá –, proto pin na katalog, disk
 * a disclosure najednou.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import settings from '../../../../../evals/play/env/settings.json';
import catalog from '../env-catalog.json';
import { LOOK_IDS } from '../index';

const LICENSE = 'generated, FLUX.2 klein 4B, Apache-2.0';
const onDisk = (url: string) => join('public', url);

describe('env catalog', () => {
  it('has at least three panoramas for every look', () => {
    for (const look of LOOK_IDS) {
      expect(catalog.entries.filter((entry) => entry.look === look).length, look).toBeGreaterThanOrEqual(3);
    }
  });

  it('has at least 40 more for the most common settings in the corpora', () => {
    expect(settings.settings.length).toBeGreaterThanOrEqual(40);
    const extra = catalog.entries.filter((entry) => entry.look === null);
    expect(extra.length).toBeGreaterThanOrEqual(40);
    for (const row of settings.settings) expect(extra.some((entry) => entry.id === `set-${row.id}`), row.id).toBe(true);
  });

  it('gives every entry a file, a licence, tags and a horizon colour', () => {
    const ids = new Set<string>();
    for (const entry of catalog.entries) {
      expect(ids.has(entry.id), entry.id).toBe(false);
      ids.add(entry.id);
      expect(existsSync(onDisk(entry.url)), entry.url).toBe(true);
      expect(existsSync(onDisk(entry.low)), entry.low).toBe(true);
      expect(entry.license).toBe(LICENSE);
      expect(entry.tags.length, entry.id).toBeGreaterThan(0);
      expect(entry.horizon).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('stays under 30 MB in total', () => {
    const bytes = catalog.entries.reduce((sum, entry) => sum + statSync(onDisk(entry.url)).size + statSync(onDisk(entry.low)).size, 0);
    expect(bytes).toBeLessThanOrEqual(30 * 1024 * 1024);
  });

  it('discloses every panorama file', () => {
    const disclosure = JSON.parse(readFileSync('disclosure.json', 'utf8')) as { entries: { name: string; kind: string }[] };
    const names = new Set(disclosure.entries.filter((entry) => entry.kind === 'asset').map((entry) => entry.name));
    for (const entry of catalog.entries) {
      expect(names.has(onDisk(entry.url).replaceAll('\\', '/')), entry.url).toBe(true);
      expect(names.has(onDisk(entry.low).replaceAll('\\', '/')), entry.low).toBe(true);
    }
  });
});
