/**
 * Měření rozmanitosti tratí P46D nad 12 větami (`sentences.json`):
 *
 *   P46D_OUT=evals/play/p46d/baseline.json [P46D_BASE=http://127.0.0.1:3247 P46D_RUN=<id> P46D_GPU=1] \
 *     npx vitest run --config vitest.measure.mts evals/play/p46d/variety.measure.ts
 *
 * Metrika tvaru (`variety.ts`) běží vždy. S `P46D_BASE` (server `next start` nad
 * buildem webpack) navíc vznikne screenshot každé hry v čase t = 10 s běhu robota
 * a slepý párový soudce (Codex přes předplatné, `sheet.png` v prázdném adresáři)
 * řekne u každé dvojice téhož žánru, jestli se tratě liší tvarem. Snímky a odpovědi
 * leží v gitignorovaném `evals/play/fidelity/runs/p46d-<run>/`; hotová odpověď se
 * při opakování nepřeptává. Výstup nemá čas ani datum.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Browser, Page } from '@playwright/test';
import { expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { ARCADE_COMPILER_VERSION } from '@/play/arcade/compile';

import {
  SHAPE_THRESHOLD,
  type Signature,
  type VarietyGenre,
  type VarietySentence,
  differentShare,
  handBuiltRunners,
  publishedGame,
  shapeDistance,
  signatureOf,
  signatureOfBodies,
  varietyPairs,
  varietySentences,
  worldOn,
} from './variety';

/** Chvíle hry na screenshotu: 10 s běhu robota (60 Hz). */
const SHOT_TICKS = 600;

export const SHAPE_QUESTION = `The attached image shows two screenshots from two different 3D games of the same genre: game A on the left, game B on the right, each taken 10 seconds into a run by the same robot player. Ignore colours, sky, lighting, textures, the characters, scenery beside the track and which 3D models the obstacles use. Judge only the SHAPE of the track or level: its bends and hills, the lanes or road width, how obstacles block the way (rows, gaps, walls, forks, bridges, tunnels) and how platforms and gaps are arranged. Do the two tracks differ in shape? Reply only with the JSON the schema asks for: different = true when the layouts are clearly built differently, false when they are the same kind of layout with only cosmetic differences; why = one sentence naming the shape you see in each game.`;

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['different', 'why'],
  properties: { different: { type: 'boolean' }, why: { type: 'string' } },
};

// Soudce vidí jen scénu: text stránky (název, věta, HUD) by mu napověděl.
const SCENE_ONLY = { content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' };

type Ask = (sheet: string, schemaFile: string, answerFile: string, question: string) => Promise<{ readonly code: number | null; readonly stderr: string }>;

/** Hra věty ze serveru a její scéna po `SHOT_TICKS` tiků robota (ruční hodiny sondy, vzor `paceClip`). */
async function shoot(page: Page, base: string, sentence: VarietySentence, file: string): Promise<void> {
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: sentence.text }) });
  const created = (await response.json()) as { versionId?: string };
  if (created.versionId === undefined) throw new Error(`${sentence.id}: POST ${response.status}`);
  await page.goto(`${base}/play/${created.versionId}`);
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => typeof (window as unknown as { __playShell?: { byHand?: unknown } }).__playShell?.byHand === 'function', undefined, { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as { __playShell: { byHand: (on: boolean) => void } }).__playShell.byHand(true));
  await page.getByTestId('play-pause').click();
  await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
  await page.addStyleTag(SCENE_ONLY);
  await page.evaluate(async (ticks) => {
    const shell = (window as unknown as { __playShell: { tickByHand: () => { runState: string } } }).__playShell;
    for (let tick = 0; tick < ticks; tick += 1) if (shell.tickByHand().runState !== 'running') break;
    // Dva snímky prohlížeče: scéna nakreslí stav po posledním tiku dřív, než ji screenshot vezme.
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  }, SHOT_TICKS);
  await page.screenshot({ path: file });
}

/** List pro soudce: hra A vlevo, B vpravo. */
async function sheet(page: Page, left: string, right: string, file: string): Promise<void> {
  const img = (path: string): string => `<img src="data:image/png;base64,${readFileSync(path).toString('base64')}">`;
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff;font:600 28px Arial,sans-serif;color:#111">
<table style="border-spacing:16px 8px"><tr><th>Game A</th><th>Game B</th></tr><tr><td>${img(left)}</td><td>${img(right)}</td></tr></table>
<style>img{width:640px;height:400px;display:block;border:2px solid #111}</style></body></html>`);
  await page.screenshot({ path: file, fullPage: true });
}

interface JudgedPair {
  readonly a: string;
  readonly b: string;
  readonly genre: VarietyGenre;
  readonly different: boolean;
  readonly why: string;
}

async function judgeShapes(base: string, run: string, sentences: readonly VarietySentence[], gpu: boolean): Promise<{ readonly run: string; readonly pairs: JudgedPair[] }> {
  const dir = join(process.cwd(), 'evals', 'play', 'fidelity', 'runs', `p46d-${run}`);
  mkdirSync(dir, { recursive: true });
  const { chromium } = createRequire(import.meta.url)('@playwright/test') as typeof import('@playwright/test');
  const angle = gpu ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const browser: Browser = await chromium.launch({ args: angle });
  const pairs: JudgedPair[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const shotOf = (id: string): string => join(dir, `${id}-t10.png`);
    for (const sentence of sentences) if (!existsSync(shotOf(sentence.id))) await shoot(page, base, sentence, shotOf(sentence.id));
    const schemaFile = join(dir, 'shape-schema.json');
    writeFileSync(schemaFile, JSON.stringify(ANSWER_SCHEMA));
    const { ask } = (await import(pathToFileURL(join(process.cwd(), 'scripts', 'p37d', 'judge-sheet.mjs')).href)) as { ask: Ask };
    const jobs = sentences.flatMap((a, i) => sentences.slice(i + 1).filter((b) => b.genre === a.genre).map((b) => ({ a, b })));
    const sheets = await browser.newPage({ viewport: { width: 1400, height: 520 } });
    for (const { a, b } of jobs) {
      const file = join(dir, `${a.id}-${b.id}-sheet.png`);
      if (!existsSync(file)) await sheet(sheets, shotOf(a.id), shotOf(b.id), file);
    }
    // Dvě otázky naráz: soudce je pomalý (desítky sekund), předplatné víc souběžných nechce.
    const queue = [...jobs];
    const worker = async (): Promise<void> => {
      for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
        const answerFile = join(dir, `${job.a.id}-${job.b.id}.answer.json`);
        if (!existsSync(answerFile)) {
          const asked = await ask(join(dir, `${job.a.id}-${job.b.id}-sheet.png`), schemaFile, answerFile, SHAPE_QUESTION);
          // Ztráta přihlášení nebo vyčerpaný limit: zastavit, ne počítat díru jako „stejné“.
          if (!existsSync(answerFile)) throw new Error(`p46d judge ${job.a.id}-${job.b.id}: no answer (exit ${asked.code}) ${asked.stderr}`);
        }
        const answer = JSON.parse(readFileSync(answerFile, 'utf8')) as { different: boolean; why: string };
        pairs.push({ a: job.a.id, b: job.b.id, genre: job.a.genre, different: answer.different, why: answer.why });
      }
    };
    await Promise.all([worker(), worker()]);
  } finally {
    await browser.close();
  }
  return { run, pairs: pairs.sort((p, q) => `${p.a}-${p.b}`.localeCompare(`${q.a}-${q.b}`)) };
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

it('measures the track variety of the P46D sentences', async () => {
  const out = process.env.P46D_OUT;
  if (out === undefined) throw new Error('p46d: set P46D_OUT=<file>');
  const sentences = varietySentences();
  const rows: { id: string; genre: VarietyGenre; seed: number | null; playable: boolean; issues: readonly string[]; signature: Signature | null }[] = [];
  for (const sentence of sentences) {
    const game = await publishedGame(sentence);
    rows.push({ id: game.id, genre: game.genre, seed: game.seed, playable: game.playable, issues: game.issues, signature: game.world === null ? null : signatureOf(game.world, game.genre) });
  }
  const pairs = varietyPairs(rows);

  // Kalibrace: první dvě semínka publikace téže věty (bez robota) a ručně různé tratě.
  const sameSentence = sentences.map((sentence) => {
    const [first, second] = derivedSeeds(seedFrom(sentence.text.trim())) as [number, number];
    return { id: sentence.id, genre: sentence.genre, distance: shapeDistance(signatureOf(worldOn(sentence.text, first), sentence.genre), signatureOf(worldOn(sentence.text, second), sentence.genre)) };
  });
  const hand = handBuiltRunners();
  const handBuilt = shapeDistance(signatureOfBodies('runner', hand.a, hand.length), signatureOfBodies('runner', hand.b, hand.length));

  const base = process.env.P46D_BASE;
  const judged = base === undefined ? null : await judgeShapes(base, process.env.P46D_RUN ?? 'baseline', sentences, process.env.P46D_GPU === '1');
  const judgeShare = (list: readonly JudgedPair[]): number | null => (list.length === 0 ? null : round3(list.filter((pair) => pair.different).length / list.length));

  const report = {
    schema: 'p46d-variety.v1',
    compiler: ARCADE_COMPILER_VERSION,
    threshold: SHAPE_THRESHOLD,
    calibration: { sameSentenceSeeds: sameSentence, handBuilt },
    summary: {
      different: differentShare(pairs),
      meanDistance: Object.fromEntries((['runner', 'steer', 'platform'] as const).map((genre) => {
        const list = pairs.filter((pair) => pair.genre === genre);
        return [genre, list.length === 0 ? null : round3(list.reduce((sum, pair) => sum + pair.distance, 0) / list.length)];
      })),
      judgeDifferent: judged === null ? null : { all: judgeShare(judged.pairs), ...Object.fromEntries((['runner', 'steer', 'platform'] as const).map((genre) => [genre, judgeShare(judged.pairs.filter((pair) => pair.genre === genre))])) },
    },
    rows,
    pairs,
    judge: judged,
  };
  writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
  expect(rows).toHaveLength(sentences.length);
});
