import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { it } from 'vitest';
import { preloadPhysics } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { pacingProbeBodies } from '@/play/arcade/pieces/pacing-parts';
import { runBot, verifyArcade } from '@/play/arcade/verify';
import { draftGameSpec } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';
import { getCompiler } from '@/app/api/play/_compiler';
import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';

it('probe: publish time per seed for the hamster sentence', async () => {
  const sentence = process.env.PROBE_SENTENCE ?? 'A hamster escapes a supermarket while a giant Roomba hunts it.';
  const spec = draftGameSpec(sentence);
  await preloadPhysics(spec, loadRapier);
  const compile = getCompiler();
  const lines: string[] = [`${sentence} | parts ${JSON.stringify(spec.assemblyParts?.map((part) => part.kind) ?? null)}`];
  const session = new Session();
  session.connect();
  if (process.env.PROBE_PROF) {
    await session.post('Profiler.enable');
    await session.post('Profiler.start');
  }
  for (const seed of [...derivedSeeds(seedFrom(sentence)), 1, 2, 3, 4, 5]) {
    const t0 = performance.now();
    const compiled = compile(spec, seed);
    const compileMs = performance.now() - t0;
    let verify = '';
    if (compiled.ok && compiled.value.arcade) {
      const t1 = performance.now();
      const v = verifyArcade(compiled.value.arcade);
      verify = `verify ${(performance.now() - t1).toFixed(0)} ms bot=${v.bot.outcome} tick=${v.bot.tick ?? '-'}`;
      const world = compiled.value.arcade;
      const th = performance.now();
      const honesty = await honestyForSpec(sentence, spec, seed, world);
      verify += ` | honesty ${(performance.now() - th).toFixed(0)} ms ${honesty?.kind ?? 'null'}`;
      if (process.env.PROBE_SPLIT === undefined) {
        lines.push(`seed ${seed}: compile ${compileMs.toFixed(0)} ms ${verify}`);
        continue;
      }
      const t2 = performance.now();
      runBot(world, undefined, { threatProofs: [] });
      const main = performance.now() - t2;
      const probes = pacingProbeBodies(world).map(({ body, behaviour }) => {
        const t3 = performance.now();
        const run = runBot(world, undefined, { roleBindings: [{ body, roleId: `pacing:${behaviour}`, label: behaviour, roleKind: 'hazard', player: false }], probeBody: body, runId: 'p' });
        const own = run.witnesses.filter((w) => w.actor.roleId === `pacing:${behaviour}`);
        return `${behaviour} ${(performance.now() - t3).toFixed(0)} ms ${run.outcome}@${run.tick} w=${own.map((w) => `${w.verb}@${w.tick}`).join('/')}`;
      });
      verify += ` | main ${main.toFixed(0)} ms | ${probes.join(' | ')} | verdict witnesses ${v.witnesses.map((w) => `${w.actor.roleId}:${w.verb}`).join(',')}`;
    }
    lines.push(`seed ${seed}: compile ${compileMs.toFixed(0)} ms ${compiled.ok ? 'ok' : compiled.reason} ${verify}`);
  }
  if (process.env.PROBE_PROF) {
    const { profile } = await session.post('Profiler.stop');
    writeFileSync(join(process.env.TMP ?? '.', `p46b-probe-${process.env.PROBE_TAG ?? 'x'}.cpuprofile`), JSON.stringify(profile));
  }
  writeFileSync(join(process.env.TMP ?? '.', `p46b-probe-${process.env.PROBE_TAG ?? 'x'}.txt`), lines.join('\n') + '\n');
}, 600000);
