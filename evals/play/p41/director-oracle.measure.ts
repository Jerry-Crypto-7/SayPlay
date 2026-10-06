/** Live oracle: only the authorized codex-cli subscription transport, no fallback. */
import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { direct } from '@/play/director';
import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { upstreamBranch, upstreamConfigFromEnv } from '@/server/upstream';

it('three owner-sentence answers play driving, shooting and racing with physical witnesses', async () => {
  const config = upstreamConfigFromEnv({ ...process.env, WORLDSMITH_MODEL_ENDPOINT: 'codex-cli', WORLDSMITH_MODEL_PROFILE: 'subscription', WORLDSMITH_MODEL: 'gpt-6-astra', WORLDSMITH_MODEL_EFFORT: 'medium', WORLDSMITH_FALLBACK_ENDPOINT: '' });
  if (config === null) {
    const reason = 'P41 oracle blocked: codex-cli subscription configuration unavailable. No paid API fallback is allowed.';
    writeFileSync('evals/play/p41/director-oracle.json', `${JSON.stringify({ transport: 'codex-cli', status: 'blocked', calls: 0, rows: [], errors: [reason] }, null, 2)}\n`);
    throw new Error(reason);
  }
  const branch = upstreamBranch(config);
  const rows: unknown[] = [];
  const errors: string[] = [];
  let calls = 0;
  for (const seed of [1, 2, 3]) {
    if (config.callCap !== null && calls + 3 > config.callCap) { errors.push(`call cap reached before seed ${seed}`); break; }
    const game = await direct('game in a car with shooting and racing', { branch, seed, now: () => performance.now(), maxRepairRounds: 2 });
    calls += game.calls;
    await preloadPhysics(game.spec, loadRapier);
    const made = arcadeWorldOf(game.spec, seed);
    const verdict = made.ok ? verifyArcade(made.world, undefined, made.roleBindings) : null;
    const witnesses = verdict?.witnesses ?? [];
    const drive = witnesses.some(witness => witness.verb === 'drive' && witness.run === 'winner');
    const shoot = witnesses.some(witness => witness.verb === 'shoot' && witness.run === 'winner');
    const race = witnesses.some(witness => witness.verb === 'race' && witness.run === 'winner');
    const ok = game.source === 'authored' && game.fallbackReason === null && verdict?.publishEligible === true && drive && shoot && race;
    rows.push({ seed, ok, source: game.source, failure: game.failure ?? null, calls: game.calls, spec: game.spec, verification: verdict, witnesses });
    if (!ok) errors.push(`seed ${seed}: ${game.failure?.reason ?? game.fallbackReason ?? 'missing physical action witnesses'}`);
    writeFileSync('evals/play/p41/director-oracle.json', `${JSON.stringify({ transport: 'codex-cli', calls, rows, errors }, null, 2)}\n`);
  }
  expect(rows).toHaveLength(3);
  expect(errors).toEqual([]);
}, 900_000);
