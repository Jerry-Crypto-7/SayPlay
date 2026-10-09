/**
 * Výběr vývojového panelu P45 (T1) – spuštěný jednou 8. 10. 2026 nad `main`
 * 0714a352, výsledek je commitnutý `panel.json`; nové spuštění po změně hry
 * by dalo jiný panel a `__tests__/panel.test.ts` by zčervenal.
 *
 * Z každé zdrojové sady (25 z `p37a/dev-150.json`, 15 z `p30/dev.json`):
 * žánr rychlého návrhu jako `evals/play/p36/depth.ts` (semínko 1, bez modelu);
 * věta, která spadne do mřížky (`grid`), nemá arkádový běh, který by robot
 * změřil, a vypadne. Podíl žánru = strop(kvóta / počet žánrů sady); věty se
 * berou po řadě (skupiny se střídají, uvnitř podle id), dokud žánr nemá svůj
 * podíl, zbytek kvóty doplní další věty v tomtéž pořadí. „Nepřítel“ = tělo role `chaser` nebo `enemy` ve světě na semínku 1
 * (živé i předloha vln; role na semínku nezávisí, rozvržení ano). Semínka
 * publikace (`_publish.ts`) holý Node nenačte – modul táhne `next/server`.
 *
 *   node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/play/p45/panel.select.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import { BODY, HEADER, ROLE, bodyBase } from '@/play/arcade/contract';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';

const PLAY = join(process.cwd(), 'evals', 'play');
const QUOTA = { 'p37a/dev-150.json': 25, 'p30/dev.json': 15 } as const;
const ENEMY_ROLES: readonly number[] = [ROLE.chaser, ROLE.enemy];

interface Sentence { readonly id: string; readonly text: string; readonly source: string; readonly group?: string }
interface Candidate { readonly sentence: Sentence; readonly genre: string; readonly enemy: boolean }

async function classify(sentence: Sentence): Promise<Candidate> {
  const { spec } = draftGameSpecWithMeta(sentence.text, 1);
  const genre = spec.genre !== undefined ? (spec.genre.mode === 'default' ? spec.genre.id : `${spec.genre.id}.${spec.genre.mode}`) : spec.control === undefined || spec.control === 'tap_go' ? 'grid' : `control:${spec.control}`;
  if (genre === 'grid') return { sentence, genre, enemy: false };
  await preloadPhysics(spec, loadRapier);
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) return { sentence, genre, enemy: false };
  const state = made.world.initial;
  const bodies = state[HEADER.bodyCount] as number;
  const enemy = Array.from({ length: bodies }, (_, body) => state[bodyBase(body) + BODY.role] as number).some((role) => ENEMY_ROLES.includes(role));
  return { sentence, genre, enemy };
}

const byId = (a: Candidate, b: Candidate): number => (a.sentence.id < b.sentence.id ? -1 : a.sentence.id > b.sentence.id ? 1 : 0);

/**
 * Pořadí: skupiny sady (`group`, v `p30/dev.json` `source`) se střídají, uvnitř
 * skupiny podle id. Čisté pořadí podle id by z `dev-150` vzalo jen `f*` a `m*`
 * (předpona id je skupina) a panel by neměl jedinou větu s neznámým slovesem.
 */
function interleaved(candidates: readonly Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of [...candidates].sort(byId)) groups.set(c.sentence.group ?? c.sentence.source, [...(groups.get(c.sentence.group ?? c.sentence.source) ?? []), c]);
  const lanes = [...groups.keys()].sort().map((group) => groups.get(group) as Candidate[]);
  const longest = Math.max(...lanes.map((lane) => lane.length));
  return Array.from({ length: longest }, (_, row) => lanes.flatMap((lane) => (lane[row] === undefined ? [] : [lane[row]]))).flat();
}

/** V pořadí `interleaved`, dokud žánr nemá svůj podíl; zbytek kvóty další věty v tomtéž pořadí. */
function pick(candidates: readonly Candidate[], quota: number): Candidate[] {
  const sorted = interleaved(candidates.filter((c) => c.genre !== 'grid'));
  const share = Math.ceil(quota / new Set(sorted.map((c) => c.genre)).size);
  const taken = new Map<string, number>();
  const picked: Candidate[] = [];
  for (const c of sorted) {
    if (picked.length === quota) break;
    if ((taken.get(c.genre) ?? 0) >= share) continue;
    taken.set(c.genre, (taken.get(c.genre) ?? 0) + 1);
    picked.push(c);
  }
  for (const c of sorted) if (picked.length < quota && !picked.includes(c)) picked.push(c);
  return picked.sort(byId);
}

// Skládání návrhu pouští robota i na fyzikálních hrách (míč) – Rapier musí být načtený dřív.
await loadRapier();
const out: Record<string, unknown>[] = [];
for (const [from, quota] of Object.entries(QUOTA)) {
  const set = JSON.parse(readFileSync(join(PLAY, from), 'utf8')) as { sentences: Sentence[] };
  const candidates: Candidate[] = [];
  for (const sentence of set.sentences) candidates.push(await classify(sentence));
  for (const c of pick(candidates, quota)) out.push({ ...c.sentence, from, genre: c.genre, enemy: c.enemy });
}
const about = 'P45 T1 dev panel: 40 sentences frozen once on 2026-10-08 over main 0714a352 before any P45 change – 25 from evals/play/p37a/dev-150.json and 15 from evals/play/p30/dev.json, groups interleaved and by id within a per-genre share of the fast draft (grid fallbacks left out: no arcade run to measure). `genre` and `enemy` (a chaser or enemy body in the world) are recorded at selection time. Never contains test-200 or any sealed set. Tune on this panel only.';
writeFileSync(join(PLAY, 'p45', 'panel.json'), `${JSON.stringify({ about, sentences: out }, null, 1)}\n`);
const genres = new Map<string, number>();
for (const s of out) genres.set(s.genre as string, (genres.get(s.genre as string) ?? 0) + 1);
console.log(out.map((s) => s.id).join(' '));
console.log('genres', Object.fromEntries(genres), 'enemy', out.filter((s) => s.enemy).length);
