/**
 * P56C T14: zapečetěná sada (40 vět nezávislého autora, T2) otevřená jednou – řetěz proti jedné hře téže věty.
 *
 *   npx vitest run --config vitest.measure.mts evals/play/p56c/holdout.measure.ts
 *   node evals/play/p56c/judge.mjs --set holdout --out evals/play/p56c/judge.json   (slepý soud, pak `final.md`)
 *
 * Každá věta jde cestou produkce bez modelu: `chainOrSingle` nad čtením slovníkem a `classifyGenre(věta, null)`;
 * věta poslaná do řetězu se postaví (`buildChain`, semínko publikace `derivedSeeds(seedFrom(věta))[0]` jako route)
 * a ověří (`verifyChain`). Výsledek `final.json`, ze kterého `judge.mjs` bere věty soudu. Nic se podle něj neladí.
 *
 * Druhé otevření odmítne `openSealedOnce` (`seal.ts`). Dokud ve stromu není rozhodnutí řetězu (T8) a slepý soudce
 * (T14), měření odmítne dřív, než sadu otevře: otevřená sada bez měření je spálená sada. Věty se na výstup
 * nevypisují, jen id.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { derivedSeeds, seedFrom } from '../../../src/app/api/play/_publish';
import { buildChain } from '../../../src/play/chain/build';
import { chainOrSingle, chainReasons } from '../../../src/play/chain/decide';
import { readForChain } from '../../../src/play/chain/read';
import { CHAIN_MIN_CONTROLS, CHAIN_SECONDS, verifyChain } from '../../../src/play/chain/verify';
import { classifyGenre } from '../../../src/play/genre/classify';

import { openSealedOnce, P56C_FAMILY_COUNTS, P56C_HOLDOUT_SHA256, type P56CFamily } from './seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p56c');
/** Co musí ve stromu být, než se sada smí otevřít. */
const NEEDED = ['src/play/chain/decide.ts', 'src/play/chain/verify.ts', 'evals/play/p56c/judge.mjs'];

interface HoldoutSentence { readonly id: string; readonly family: P56CFamily; readonly text: string }

interface ChainRow { readonly ok: boolean; readonly keys: readonly string[]; readonly controls: number; readonly lengthSec: number; readonly failures: readonly string[] }

it('opens the sealed P56C holdout once and writes final.json (T14)', () => {
  const missing = NEEDED.filter((file) => !existsSync(join(process.cwd(), file)));
  if (missing.length > 0) throw new Error(`not ready to open the holdout (${missing.join(', ')} missing); opening it now would burn it`);
  const commit = execFileSync('git', ['--no-replace-objects', 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const bytes = openSealedOnce(DIR, P56C_HOLDOUT_SHA256, commit, 'P56C T14 (holdout.measure.ts)');
  const openedAt = (JSON.parse(readFileSync(join(DIR, 'holdout-opened.json'), 'utf8')) as { openedAt: string }).openedAt;

  const rows = (JSON.parse(bytes) as { sentences: HoldoutSentence[] }).sentences.map((sentence) => {
    const read = readForChain(sentence.text, null);
    const ranking = classifyGenre(sentence.text, null);
    const [top, second] = ranking.ranked;
    const route = chainOrSingle(sentence.text, read, ranking);
    const base = {
      ...sentence,
      route,
      reasons: chainReasons(sentence.text, read, ranking),
      top: top === undefined ? null : `${top.genre}.${top.mode} ${String(top.score)} (náskok ${String(top.score - (second?.score ?? 0))})`,
    };
    if (route !== 'chain') return { ...base, chain: null };
    const built = buildChain(sentence.text, read, derivedSeeds(seedFrom(sentence.text.trim()))[0]!);
    if (!built.ok) return { ...base, chain: { ok: false, keys: [], controls: 0, lengthSec: 0, failures: built.issues } satisfies ChainRow };
    const verdict = verifyChain(built.chain);
    return { ...base, chain: { ok: verdict.failures.length === 0, keys: built.chain.rounds.map((round) => round.key), controls: verdict.controls, lengthSec: verdict.lengthSec, failures: verdict.failures } satisfies ChainRow };
  });

  const chains = rows.flatMap((row) => (row.chain === null ? [] : [row.chain]));
  const count = <T>(list: readonly T[], ok: (item: T) => boolean) => ({ hit: list.filter(ok).length, of: list.length });
  const families = Object.keys(P56C_FAMILY_COUNTS) as P56CFamily[];
  const routedBy: Record<string, { hit: number; of: number }> = Object.fromEntries(families.map((family) => [family, count(rows.filter((row) => row.family === family), (row) => row.route === 'chain')]));
  const summary = {
    routed: { ...routedBy, all: count(rows, (row) => row.route === 'chain') },
    chains: {
      built: count(chains, (chain) => chain.keys.length > 0),
      verified: count(chains, (chain) => chain.ok),
      controls: count(chains, (chain) => chain.controls >= CHAIN_MIN_CONTROLS),
      length: count(chains, (chain) => chain.lengthSec >= CHAIN_SECONDS.min && chain.lengthSec <= CHAIN_SECONDS.max),
    },
  };
  const gates = { judgeChainShare: 0.7, controlsShare: 0.8, minControls: CHAIN_MIN_CONTROLS, verified: 1, seconds: CHAIN_SECONDS };
  writeFileSync(join(DIR, 'final.json'), `${JSON.stringify({ schema: 'p56c-final.v1', commit, openedAt, sha256: P56C_HOLDOUT_SHA256, gates, summary, rows }, null, 1)}\n`);
  const routed = families.map((family) => `${family} ${String(routedBy[family]!.hit)}/${String(routedBy[family]!.of)}`).join(' · ');
  console.log(`routed to chain: ${routed} · chains ${String(chains.length)}: verifyChain ${String(summary.chains.verified.hit)}, ≥ ${String(CHAIN_MIN_CONTROLS)} controls ${String(summary.chains.controls.hit)}, ${String(CHAIN_SECONDS.min)}–${String(CHAIN_SECONDS.max)} s ${String(summary.chains.length.hit)}`);
}, 30 * 60_000);
