import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';

const root = path.resolve(process.argv[2] ?? 'plans/P20/reference-scenes');
const ids = ['interior', 'courtyard', 'observatory'];
const variants = ['full', 'clay', 'proxy', 'layout', 'light', 'camera', 'no-ibl', 'no-shadows'];
const labels = ['Full surfaces', 'Original clay', 'Asset boxes', 'Grid layout', 'Original light / no IBL', 'Wide camera', 'No IBL only', 'No shadows only'];
const width = variants.length * 400;
const scores = [];
const rows = [];
const media = [];
for (const id of ids) {
  // MediaRecorder streams omit seek metadata. Remux only; preserve rendered frames.
  const movie = path.join(root, `${id}-review.webm`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(root, `${id}-flythrough.webm`), '-c', 'copy', movie], { windowsHide: true });
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name', '-of', 'json', movie], { encoding: 'utf8', windowsHide: true }));
  if (Number(probe.format.duration) < 20 || Number(probe.format.duration) > 21) throw new Error(`Unexpected recording duration: ${id}`);
  media.push({ scene: id, ...probe });
  const full = await sharp(path.join(root, `${id}-full.png`)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const variant of variants.slice(1)) {
    const other = await sharp(path.join(root, `${id}-${variant}.png`)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (JSON.stringify(full.info) !== JSON.stringify(other.info)) throw new Error(`Image sizes differ: ${id}/${variant}`);
    let total = 0, changed = 0;
    for (let offset = 0; offset < full.data.length; offset += 3) {
      const diff = [0, 1, 2].map(channel => Math.abs(full.data[offset + channel] - other.data[offset + channel]));
      total += diff[0] + diff[1] + diff[2];
      if (Math.max(...diff) > 12) changed++;
    }
    scores.push({ scene: id, ablation: variant, meanAbsoluteChannelDifference: total / full.data.length,
      changedPixelPercent: changed / (full.info.width * full.info.height) * 100 });
  }
  const thumbs = await Promise.all(variants.map(async (variant, column) => ({
    input: await sharp(path.join(root, `${id}-${variant}.png`)).resize(400, 240, { fit: 'contain', background: '#18252b' }).png().toBuffer(),
    left: column * 400, top: 28,
  })));
  const title = Buffer.from(`<svg width="${width}" height="28"><rect width="${width}" height="28" fill="#18252b"/>${labels.map((label, index) => `<text x="${index * 400 + 12}" y="20" fill="#f4eee1" font-family="sans-serif" font-size="15">${id} / ${label}</text>`).join('')}</svg>`);
  rows.push({ input: await sharp({ create: { width, height: 268, channels: 3, background: '#18252b' } })
    .composite([{ input: title, left: 0, top: 0 }, ...thumbs]).png().toBuffer(), left: 0, top: rows.length * 268 });
}
await sharp({ create: { width, height: 804, channels: 3, background: '#18252b' } }).composite(rows).png().toFile(path.join(root, 'comparisons.png'));
for (const id of ids) {
  const views = await Promise.all([1, 2, 3, 4].map(async (view, i) => ({ input: await sharp(path.join(root, `${id}-view${view}.png`)).resize(800, 470).png().toBuffer(), left: i % 2 * 800, top: Math.floor(i / 2) * 470 })));
  await sharp({ create: { width: 1600, height: 940, channels: 3, background: '#18252b' } }).composite(views).png().toFile(path.join(root, `${id}-four-views.png`));
}
const hero = await Promise.all(ids.map(async (id, index) => ({ input: await sharp(path.join(root, `${id}-full.png`)).resize(800, 480, { fit: 'contain', background: '#18252b' }).png().toBuffer(), left: 0, top: index * 480 })));
await sharp({ create: { width: 800, height: 1440, channels: 3, background: '#18252b' } }).composite(hero).png().toFile(path.join(root, 'three-scenes.png'));
await fs.writeFile(path.join(root, 'image-differences.json'), JSON.stringify({ warning: 'Pixel differences measure image change, not visual quality or a percentage of aesthetic improvement.', scores }, null, 2));
await fs.writeFile(path.join(root, 'media.json'), JSON.stringify(media, null, 2));
await fs.writeFile(path.join(root, 'index.html'), `<!doctype html><meta charset="utf-8"><title>T04 · Three reference scenes</title>
<style>body{margin:32px;background:#18252b;color:#f4eee1;font:16px/1.5 system-ui}h1,h2{font-weight:500}img,video{max-width:100%}.views{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0}a{color:#aad7e0}section{margin:64px 0}summary{cursor:pointer}textarea{width:96%;min-height:90px;background:#26363d;color:white;padding:12px}</style>
<h1>T04 · Three hand-authored references</h1><p>Development renderer oracles, not generated worlds. Local assets, production WorldstreamStage, hand-built architecture. Each movie captures the actual WebGL canvas for a 20-second camera path.</p>
<p>Review each scene: recognizable place and objects? People seated naturally? Coherent materials and lighting? Best camera view? Rate readability and visual impression 1–5. These scores are pending human review.</p>
${ids.map(id => `<section><h2>${id}</h2><div class="views">${[1, 2, 3, 4].map(view => `<figure><a href="${id}-view${view}.png"><img src="${id}-view${view}.png"></a><figcaption>View ${view}</figcaption></figure>`).join('')}</div><video controls preload="metadata" src="${id}-review.webm"></video><details><summary>Controlled comparisons</summary><div class="views">${variants.map((variant, i) => `<figure><img src="${id}-${variant}.png"><figcaption>${labels[i]}</figcaption></figure>`).join('')}<figure><img src="${id}-lamp-off.png"><figcaption>Lamp switched off</figcaption></figure></div></details><p><a href="${id}-evidence.json">Renderer evidence</a></p><label>Review notes (copy before closing; not saved)<textarea aria-label="${id} review"></textarea></label></section>`).join('')}
<p>Pixel-change measurements in <a href="image-differences.json">image-differences.json</a> are diagnostics, not quality scores. No live-generation gate is certified by this gallery.</p>`);
console.log(`Reference gallery and controlled image differences: ${root}`);
