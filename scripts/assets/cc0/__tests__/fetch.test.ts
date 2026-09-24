import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { strToU8, zipSync } from 'three/addons/libs/fflate.module.js';
import { describe, expect, it } from 'vitest';

import { fetchPacks, licenseProblem } from '../fetch.mjs';

const CC0_TEXT = 'License: (Creative Commons Zero, CC0)\nhttp://creativecommons.org/publicdomain/zero/1.0/';
const NC_TEXT = 'License: Creative Commons Attribution-NonCommercial 4.0 (CC BY-NC 4.0)';

function pack(id: string, license = 'CC0-1.0') {
  return { id, author: 'Test', kind: 'github-zip', repo: `x/${id}`, branch: 'main', pageUrl: `https://example.test/${id}`, license, licenseUrl: 'https://example.test/l' };
}

function zipWith(licenseText: string): Uint8Array {
  return zipSync({
    'repo-main/LICENSE.txt': strToU8(licenseText),
    'repo-main/Assets/gltf/chair.gltf': strToU8('{"asset":{"version":"2.0"}}'),
    'repo-main/Assets/fbx/chair.fbx': strToU8('fbx'),
  });
}

function fakeFetch(bodies: Record<string, Uint8Array>) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const id = Object.keys(bodies).find((key) => url.includes(key));
    if (id === undefined) return new Response('missing', { status: 404 });
    return new Response(bodies[id] as BodyInit);
  };
  return { impl, calls };
}

describe('CC0 pack licences', () => {
  it('accepts only CC0-1.0 and CC-BY-4.0 declarations', () => {
    expect(licenseProblem(pack('a', 'CC0-1.0'))).toBeNull();
    expect(licenseProblem(pack('a', 'CC-BY-4.0'))).toBeNull();
    expect(licenseProblem(pack('a', 'CC-BY-NC-4.0'))).toMatch(/not allowed/);
    expect(licenseProblem(pack('a', 'CC-BY-SA-4.0'))).toMatch(/not allowed/);
    expect(licenseProblem(pack('a', ''))).toMatch(/not allowed/);
  });
});

describe('fetchPacks', () => {
  it('refuses a pack whose declared licence is outside the allowlist without downloading it', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'cc0-'));
    const { impl, calls } = fakeFetch({ nc: zipWith(NC_TEXT) });
    const { records, downloaded } = await fetchPacks({ packs: [pack('nc', 'CC-BY-NC-4.0')], cacheDir, fetchImpl: impl });
    expect(downloaded).toBe(0);
    expect(calls).toEqual([]);
    expect(records[0]).toMatchObject({ pack: 'nc', skipped: expect.stringMatching(/not allowed/) });
  });

  it('refuses a pack whose bundled licence text contradicts the declaration', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'cc0-'));
    const { impl } = fakeFetch({ liar: zipWith(NC_TEXT) });
    const { records } = await fetchPacks({ packs: [pack('liar')], cacheDir, fetchImpl: impl });
    expect(records[0]).toMatchObject({ pack: 'liar', skipped: expect.stringMatching(/licen[cs]e text/i) });
    expect(existsSync(path.join(cacheDir, 'liar'))).toBe(false);
  });

  it('stores the licence text next to the pack, keeps only glTF files, and downloads nothing the second time', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'cc0-'));
    const { impl, calls } = fakeFetch({ good: zipWith(CC0_TEXT) });
    const first = await fetchPacks({ packs: [pack('good')], cacheDir, fetchImpl: impl });
    expect(first.downloaded).toBe(1);
    const record = first.records[0];
    expect(record).toMatchObject({ pack: 'good', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: expect.any(Number) });
    expect(readFileSync(record.licenseFile, 'utf8')).toBe(CC0_TEXT);
    expect(path.dirname(record.licenseFile)).toBe(cacheDir);
    expect(existsSync(path.join(cacheDir, 'good', 'Assets/gltf/chair.gltf'))).toBe(true);
    expect(existsSync(path.join(cacheDir, 'good', 'Assets/fbx/chair.fbx'))).toBe(false);

    const second = await fetchPacks({ packs: [pack('good')], cacheDir, fetchImpl: impl });
    expect(second.downloaded).toBe(0);
    expect(calls).toHaveLength(1);
    expect(second.records[0]).toEqual(record);
  });

  it('loads a manually downloaded zip for a pack that needs a click', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'cc0-'));
    mkdirSync(path.join(cacheDir, 'manual'));
    writeFileSync(path.join(cacheDir, 'manual', 'itch.zip'), zipWith(CC0_TEXT));
    const manual = { ...pack('itch'), kind: 'manual', reason: 'itch.io needs a click' };
    const { impl, calls } = fakeFetch({});
    const { records, downloaded } = await fetchPacks({ packs: [manual], cacheDir, fetchImpl: impl });
    expect(calls).toEqual([]);
    expect(downloaded).toBe(1);
    expect(records[0]).toMatchObject({ pack: 'itch', models: 1, url: expect.stringContaining('manual') });
    expect(existsSync(path.join(cacheDir, 'itch', 'Assets/gltf/chair.gltf'))).toBe(true);
  });

  it('logs a pack that needs a click as skipped and carries on', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'cc0-'));
    const { impl } = fakeFetch({ good: zipWith(CC0_TEXT) });
    const manual = { ...pack('drive'), kind: 'manual', reason: 'Google Drive needs a click' };
    const { records, downloaded } = await fetchPacks({ packs: [manual, pack('good')], cacheDir, fetchImpl: impl });
    expect(downloaded).toBe(1);
    expect(records.map((r: { pack: string; skipped?: string }) => [r.pack, r.skipped ?? null])).toEqual([['drive', 'Google Drive needs a click'], ['good', null]]);
    expect(records[0]).toMatchObject({ url: 'https://example.test/drive' });
  });
});

/** Veřejná složka Drive tak, jak ji vrací `embeddedfolderview`: podsložky a soubory. */
function folderView(entries: Array<[string, string, 'folder' | 'file']>) {
  return entries.map(([name, id, kind]) => (kind === 'folder'
    ? `<a href="https://drive.google.com/drive/folders/${id}" target="_blank"><div class="flip-entry-title">${name}</div></a>`
    : `<a href="https://drive.google.com/file/d/${id}/view?usp=drive_web" target="_blank"><div class="flip-entry-title">${name}</div></a>`)).join('\n');
}

const OBJ = ['mtllib Box.mtl', 'o Box', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 0 0 1', 'usemtl Red', 'f 1 2 3', 'usemtl Green', 'f 1 3 4', ''].join('\n');
const MTL = ['newmtl Red', 'Kd 0.8 0.1 0.1', 'newmtl Green', 'Kd 0.1 0.7 0.2', ''].join('\n');
const PAGE_CC0 = (folder: string) => `<a href="https://drive.google.com/drive/folders/${folder}?usp=sharing">Download</a> <a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</a>`;

/** Falešný web: autorova stránka, výpisy složek a soubory ke stažení podle id. */
function driveWeb(pages: Record<string, string>, folders: Record<string, string>, files: Record<string, string>) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    if (pages[url] !== undefined) return new Response(pages[url]);
    const folder = url.match(/embeddedfolderview\?id=([\w-]+)/)?.[1];
    if (folder && folders[folder] !== undefined) return new Response(folders[folder]);
    const file = url.match(/download\?id=([\w-]+)/)?.[1];
    if (file && files[file] !== undefined) return new Response(files[file]);
    return new Response('missing', { status: 404 });
  };
  return { impl, calls };
}

const drivePack = (over: Record<string, unknown> = {}) => ({
  id: 'q-food', author: 'Quaternius (quaternius.com)', kind: 'drive-folder', folderId: 'ROOT', pageUrl: 'https://quaternius.com/packs/food.html',
  license: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', ...over,
});

describe('fetchPacks from the author\'s Drive folder', () => {
  const folders = {
    ROOT: folderView([['FBX', 'FBXDIR', 'folder'], ['OBJ', 'OBJDIR', 'folder'], ['License.txt', 'LIC', 'file'], ['Preview.png', 'PREV', 'file']]),
    OBJDIR: folderView([['Box.obj', 'BOXOBJ', 'file'], ['Box.mtl', 'BOXMTL', 'file']]),
    FBXDIR: folderView([['Box.fbx', 'BOXFBX', 'file']]),
  };
  const files = { LIC: 'License:\nCC0 1.0 Universal (CC0 1.0)\nPublic Domain Dedication', BOXOBJ: OBJ, BOXMTL: MTL, BOXFBX: 'fbx' };

  it('walks the folder linked from the author page, prefers OBJ over FBX and converts it to a coloured GLB', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'cc0-'));
    const { impl, calls } = driveWeb({ 'https://quaternius.com/packs/food.html': PAGE_CC0('ROOT') }, folders, files);
    const { records, downloaded } = await fetchPacks({ packs: [drivePack()], cacheDir, fetchImpl: impl });
    expect(records[0].skipped ?? null).toBeNull(); expect(downloaded).toBe(1);
    expect(records[0]).toMatchObject({ pack: 'q-food', models: 1, license: 'CC0-1.0' });
    expect(calls.some((url) => url.includes('BOXFBX'))).toBe(false);
    expect(readFileSync(records[0].licenseFile, 'utf8')).toMatch(/CC0 1\.0 Universal/);
    const doc = await new NodeIO().read(path.join(cacheDir, 'q-food', 'OBJ', 'Box.glb'));
    const colours = doc.getRoot().listMaterials().map((m) => [m.getName(), m.getBaseColorFactor().slice(0, 3).map((c) => Math.round(c * 10) / 10)]);
    expect(Object.fromEntries(colours)).toEqual({ Red: [0.8, 0.1, 0.1], Green: [0.1, 0.7, 0.2] });
    expect(doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())).toHaveLength(2);
  });

  it('prefers a glTF subfolder over OBJ', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'cc0-'));
    const withGltf = { ...folders, ROOT: folderView([['glTF', 'GLTFDIR', 'folder'], ['OBJ', 'OBJDIR', 'folder'], ['License.txt', 'LIC', 'file']]), GLTFDIR: folderView([['Box.gltf', 'BOXGLTF', 'file']]) };
    const { impl, calls } = driveWeb({ 'https://quaternius.com/packs/food.html': PAGE_CC0('ROOT') }, withGltf, { ...files, BOXGLTF: '{"asset":{"version":"2.0"}}' });
    const { records } = await fetchPacks({ packs: [drivePack()], cacheDir, fetchImpl: impl });
    expect(records[0]).toMatchObject({ models: 1 });
    expect(calls.some((url) => url.includes('BOXOBJ'))).toBe(false);
    expect(existsSync(path.join(cacheDir, 'q-food', 'glTF', 'Box.gltf'))).toBe(true);
  });

  it('refuses a folder that the author page does not link – a repackaged mirror looks the same', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'cc0-'));
    const { impl, calls } = driveWeb({ 'https://quaternius.com/packs/food.html': PAGE_CC0('SOMEONE-ELSE') }, folders, files);
    const { records, downloaded } = await fetchPacks({ packs: [drivePack()], cacheDir, fetchImpl: impl });
    expect(downloaded).toBe(0);
    expect(records[0]).toMatchObject({ pack: 'q-food', skipped: expect.stringMatching(/author page/) });
    expect(calls.some((url) => url.includes('download?id='))).toBe(false);
  });

  it('refuses a pack with no author page', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'cc0-'));
    const { impl } = driveWeb({}, folders, files);
    const { records } = await fetchPacks({ packs: [drivePack({ pageUrl: undefined })], cacheDir, fetchImpl: impl });
    expect(records[0]).toMatchObject({ skipped: expect.stringMatching(/author page/) });
  });

  it('refuses a pack with neither a licence file nor a CC0 statement on the author page', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'cc0-'));
    const bare = { ...folders, ROOT: folderView([['OBJ', 'OBJDIR', 'folder']]) };
    const { impl } = driveWeb({ 'https://quaternius.com/packs/food.html': '<a href="https://drive.google.com/drive/folders/ROOT">Download</a>' }, bare, files);
    const { records } = await fetchPacks({ packs: [drivePack()], cacheDir, fetchImpl: impl });
    expect(records[0]).toMatchObject({ skipped: expect.stringMatching(/licen[cs]e/i) });
    expect(existsSync(path.join(cacheDir, 'q-food'))).toBe(false);
  });

  it('accepts the CC0 statement on the author page when the folder has no licence file', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'cc0-'));
    const bare = { ...folders, ROOT: folderView([['OBJ', 'OBJDIR', 'folder']]) };
    const { impl } = driveWeb({ 'https://quaternius.com/packs/food.html': PAGE_CC0('ROOT') }, bare, files);
    const { records } = await fetchPacks({ packs: [drivePack()], cacheDir, fetchImpl: impl });
    expect(records[0]).toMatchObject({ models: 1 });
    expect(readFileSync(records[0].licenseFile, 'utf8')).toMatch(/quaternius\.com\/packs\/food\.html[\s\S]*publicdomain\/zero/);
  });
});
