#!/usr/bin/env node
/**
 * Listy pro kontrolu knihovny (P30D T1): každý záznam `src/assets/catalog.json`
 * vyfotí ze čtyř úhlů do jednoho PNG 1024×1024.
 *
 * ```
 * node scripts/assets/qa-sheets.mjs                    všechny chybějící listy
 * node scripts/assets/qa-sheets.mjs --only a,b         jen vybrané assetId
 * node scripts/assets/qa-sheets.mjs --out <adresář>    jinam než D:/caches/p30d/sheets
 * node scripts/assets/qa-sheets.mjs --glb-list <json>  modely mimo katalog: [{ "id", "glb" }] (P37D)
 * node scripts/assets/qa-sheets.mjs --grid 3 --out D:/caches/p43/grids   mřížky 3×3 pro slepý soud (P43)
 * ```
 *
 * Rozvržení listu: vlevo nahoře zepředu, vpravo nahoře z boku, vlevo dole
 * shora – tyhle tři rámují jen model. Vpravo dole je ¾ pohled s kostkou 1 m
 * vedle modelu, aby šla posoudit velikost; rozměry v metrech stojí v rohu.
 * Existující `.png` náhledy vedle GLB jsou jen jeden úhel, proto vlastní render.
 *
 * Listy leží mimo repo. Běh jde přerušit a navázat: hotový list se přeskočí.
 * Selhání se zapíše do `failures.json` vedle listů s důvodem, běh pokračuje.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gridPlan } from './qa-grid.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
};
const outDir = flag('--out') ?? 'D:/caches/p30d/sheets';
const only = flag('--only')?.split(',');
const gridSize = flag('--grid') === null ? null : Number(flag('--grid'));

// Modely z cache výroby (P37D) leží mimo `public/`; každý dostane vlastní adresu `/ext/<pořadí>.glb`.
const external = flag('--glb-list') ? JSON.parse(readFileSync(flag('--glb-list'), 'utf8')) : null;
const catalog = external
  ? external.map((model, index) => ({ assetId: model.id, lods: [{ level: 0, path: `/ext/${index}.glb` }] }))
  : JSON.parse(readFileSync(join(root, 'src/assets/catalog.json'), 'utf8')).assets;
const todo = catalog.filter((asset) => (only ? only.includes(asset.assetId) : true))
  .filter((asset) => only || !existsSync(join(outDir, `${asset.assetId}.png`)));
mkdirSync(outDir, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.png': 'image/png', '.bin': 'application/octet-stream' };
// `three` tam, kde ho najde Node: worktree bez vlastních node_modules ho bere z hlavního checkoutu.
const MOUNTS = [['/three/', join(dirname(dirname(require.resolve('three'))), '/')], ['/', join(root, 'public/')]];

const PAGE = `<!doctype html><html><body style="margin:0">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const SIZE = 512;
const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(SIZE, SIZE);
renderer.outputColorSpace = T.SRGBColorSpace;
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const sheet = document.createElement('canvas');
sheet.width = sheet.height = SIZE * 2;
const ctx = sheet.getContext('2d');

function stage() {
  const scene = new T.Scene();
  scene.background = new T.Color('#b9bdc3');
  scene.add(new T.HemisphereLight('#ffffff', '#6b6f75', 2.2));
  const sun = new T.DirectionalLight('#ffffff', 2.4);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  return scene;
}

function shoot(scene, box, direction) {
  const center = box.getCenter(new T.Vector3());
  const radius = Math.max(box.getSize(new T.Vector3()).length() / 2, 0.01);
  const camera = new T.PerspectiveCamera(30, 1, radius / 100, radius * 100);
  const distance = radius / Math.sin(T.MathUtils.degToRad(15)) * 1.05;
  camera.position.copy(center).add(direction.clone().normalize().multiplyScalar(distance));
  if (Math.abs(direction.y) > 0.99) camera.up.set(0, 0, -1);
  camera.lookAt(center);
  renderer.render(scene, camera);
}

window.renderSheet = async (url) => {
  const gltf = await loader.loadAsync(url);
  const scene = stage();
  scene.add(gltf.scene);
  scene.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(gltf.scene);
  if (box.isEmpty()) throw new Error('empty bounds');
  const size = box.getSize(new T.Vector3());
  const views = [new T.Vector3(0, 0.15, 1), new T.Vector3(1, 0.15, 0), new T.Vector3(0, 1, 0)];
  views.forEach((direction, index) => {
    shoot(scene, box, direction);
    ctx.drawImage(renderer.domElement, (index % 2) * SIZE, Math.floor(index / 2) * SIZE);
  });
  const cube = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial({ color: '#e8e2d0', roughness: 0.9 }));
  // Vlevo za modelem: kamera se dívá zprava zepředu, takže kostka model nezakryje.
  cube.position.set(box.min.x - 0.15 - 0.5, box.min.y + 0.5, box.min.z + 0.5);
  scene.add(cube);
  shoot(scene, box.clone().expandByObject(cube), new T.Vector3(1.2, 0.8, 1.6));
  ctx.drawImage(renderer.domElement, SIZE, SIZE);
  ctx.strokeStyle = '#555'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(SIZE, 0); ctx.lineTo(SIZE, SIZE * 2); ctx.moveTo(0, SIZE); ctx.lineTo(SIZE * 2, SIZE); ctx.stroke();
  ctx.font = '20px sans-serif'; ctx.fillStyle = '#111';
  const labels = ['front', 'side', 'top', '3/4 with 1 m cube'];
  labels.forEach((text, index) => ctx.fillText(text, (index % 2) * SIZE + 10, Math.floor(index / 2) * SIZE + 28));
  ctx.fillText(size.x.toFixed(2) + ' x ' + size.y.toFixed(2) + ' x ' + size.z.toFixed(2) + ' m (w x h x d)', SIZE + 10, SIZE * 2 - 14);
  return sheet.toDataURL('image/png');
};

// P43 T10: mřížka n×n, v buňce ¾ pohled, číslo buňky a rozměry; žádné jméno.
window.renderGrid = async (urls, n) => {
  const CELL = 340;
  const grid = document.createElement('canvas');
  grid.width = grid.height = CELL * n;
  const g = grid.getContext('2d');
  g.fillStyle = '#b9bdc3'; g.fillRect(0, 0, grid.width, grid.height);
  const failed = [];
  for (let cell = 0; cell < urls.length; cell++) {
    const x = (cell % n) * CELL, y = Math.floor(cell / n) * CELL;
    try {
      const gltf = await loader.loadAsync(urls[cell]);
      const scene = stage();
      scene.add(gltf.scene);
      scene.updateMatrixWorld(true);
      const box = new T.Box3().setFromObject(gltf.scene);
      if (box.isEmpty()) throw new Error('empty bounds');
      const size = box.getSize(new T.Vector3());
      shoot(scene, box, new T.Vector3(1.2, 0.8, 1.6));
      g.drawImage(renderer.domElement, x, y, CELL, CELL);
      g.font = '16px sans-serif'; g.fillStyle = '#111';
      g.fillText(size.x.toFixed(1) + ' x ' + size.y.toFixed(1) + ' x ' + size.z.toFixed(1) + ' m', x + 8, y + CELL - 10);
    } catch (error) {
      failed.push(cell);
    }
    g.fillStyle = '#111'; g.fillRect(x, y, 44, 40);
    g.font = 'bold 28px sans-serif'; g.fillStyle = '#fff';
    g.fillText(String(cell + 1), x + 12, y + 30);
  }
  g.strokeStyle = '#333'; g.lineWidth = 3;
  for (let i = 1; i < n; i++) {
    g.beginPath(); g.moveTo(i * CELL, 0); g.lineTo(i * CELL, grid.height); g.moveTo(0, i * CELL); g.lineTo(grid.width, i * CELL); g.stroke();
  }
  return { data: grid.toDataURL('image/png'), failed };
};
window.ready = true;
</script></body></html>`;

function resolveFile(url) {
  const path = decodeURIComponent(url.split('?')[0]);
  if (path === '/' || path === '/index.html') return null;
  const ext = external && /^\/ext\/(\d+)\.glb$/.exec(path);
  if (ext) return external[Number(ext[1])]?.glb;
  for (const [prefix, dir] of MOUNTS) {
    if (!path.startsWith(prefix)) continue;
    const file = normalize(join(dir, path.slice(prefix.length)));
    return file.startsWith(normalize(dir)) ? file : undefined;
  }
  return undefined;
}

const server = createServer((request, response) => {
  const file = resolveFile(request.url);
  if (file === null) return response.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  if (!file || !existsSync(file)) return response.writeHead(404).end();
  response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

const { chromium } = require('@playwright/test');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const failuresFile = join(outDir, 'failures.json');
const failures = existsSync(failuresFile) ? JSON.parse(readFileSync(failuresFile, 'utf8')) : {};
let page = null;
let done = 0;
const lod0Of = (asset) => asset.lods?.find((lod) => lod.level === 0) ?? asset.lods?.[0];

if (gridSize !== null) {
  // Mřížkové listy (P43 T10): `grid-index.json` je jediná cesta z buňky zpět na model.
  const byId = new Map(catalog.map((asset) => [asset.assetId, asset]));
  const plan = gridPlan(catalog, gridSize);
  writeFileSync(join(outDir, 'grid-index.json'), `${JSON.stringify({ size: gridSize, sheets: plan }, null, 1)}\n`);
  page = await browser.newPage();
  await page.goto(base);
  await page.waitForFunction(() => window.ready === true);
  for (const { sheet, cells } of plan) {
    if (existsSync(join(outDir, `${sheet}.png`))) continue;
    const urls = cells.map((id) => lod0Of(byId.get(id))?.path ?? '/missing.glb');
    const { data, failed } = await page.evaluate(([list, n]) => window.renderGrid(list, n), [urls, gridSize]);
    writeFileSync(join(outDir, `${sheet}.png`), Buffer.from(data.split(',')[1], 'base64'));
    for (const cell of failed) failures[cells[cell]] = `${sheet} cell ${cell + 1}: render failed`;
    done += 1;
    if (done % 10 === 0) console.log(`${done}/${plan.length}`);
  }
  writeFileSync(failuresFile, `${JSON.stringify(failures, null, 2)}\n`);
  await browser.close();
  server.close();
  console.log(`grids ${plan.length}, failures ${Object.keys(failures).length} (${failuresFile})`);
  process.exit(Object.keys(failures).length ? 1 : 0);
}

for (const asset of todo) {
  const lod0 = asset.lods?.find((lod) => lod.level === 0) ?? asset.lods?.[0];
  try {
    if (!lod0) throw new Error('no LOD in catalog entry');
    if (!page) {
      page = await browser.newPage();
      await page.goto(base);
      await page.waitForFunction(() => window.ready === true);
    }
    const data = await page.evaluate((url) => window.renderSheet(url), lod0.path);
    writeFileSync(join(outDir, `${asset.assetId}.png`), Buffer.from(data.split(',')[1], 'base64'));
    delete failures[asset.assetId];
  } catch (error) {
    failures[asset.assetId] = String(error?.message ?? error).split('\n')[0];
    await page?.close().catch(() => {});
    page = null;
  }
  done += 1;
  if (done % 50 === 0) console.log(`${done}/${todo.length}`);
}

writeFileSync(failuresFile, `${JSON.stringify(failures, null, 2)}\n`);
await browser.close();
server.close();
const total = catalog.filter((asset) => existsSync(join(outDir, `${asset.assetId}.png`))).length;
console.log(`sheets ${total}/${catalog.length}, failures ${Object.keys(failures).length} (${failuresFile})`);
process.exitCode = Object.keys(failures).length ? 1 : 0;
