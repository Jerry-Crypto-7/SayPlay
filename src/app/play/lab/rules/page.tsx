import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import carryKey from '@/play/arcade/__fixtures__/rules/carry-key.json';
import collectGate from '@/play/arcade/__fixtures__/rules/collect-gate.json';
import giveFlower from '@/play/arcade/__fixtures__/rules/give-flower.json';
import leverBridge from '@/play/arcade/__fixtures__/rules/lever-bridge.json';
import pushCrate from '@/play/arcade/__fixtures__/rules/push-crate.json';
import throwRock from '@/play/arcade/__fixtures__/rules/throw-rock.json';
import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import { runBot } from '@/play/arcade/verify';
import { readGameSpec, type GameSpecV1 } from '@/play/spec';

import { RulesLab, RulesReplay } from './RulesLab';

const FIXTURES: Readonly<Record<string, unknown>> = {
  'carry-key': carryKey,
  'collect-gate': collectGate,
  'give-flower': giveFlower,
  'lever-bridge': leverBridge,
  'push-crate': pushCrate,
  'throw-rock': throwRock,
  // Kámen jako těleso Rapieru (T13) – hod letí přes `PhysicsSession`.
  'throw-rock-physics': { ...throwRock, things: [{ role: 'rock', physics: true }] },
};

/**
 * `/play/lab/rules?f=<fixture>` – ruční hra pravidel, kterou přehraje robot
 * (P29A T6), aby e2e viděla nesenou, hozenou a přepnutou věc. Svět se
 * překládá tady (překlad potřebuje `node:crypto`), klient ho jen hraje.
 * `&replay=1`: robot hraje tady v Node a klient jeho záznam přehraje (R4).
 * Mimo vývoj jen s `PLAY_LAB=1`, jinak 404 – porotce na ni nemá narazit.
 */
export default async function RulesLabPage({ searchParams }: { readonly searchParams: Promise<{ readonly f?: string; readonly replay?: string }> }) {
  await connection();
  if (process.env.NODE_ENV === 'production' && process.env.PLAY_LAB !== '1') notFound();
  const { f, replay } = await searchParams;
  if (f === undefined || !Object.hasOwn(FIXTURES, f)) notFound();
  const spec = readGameSpec(FIXTURES[f]);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const made = arcadeWorldOf(spec.value as GameSpecV1, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  if (replay === '1') {
    await preloadPhysics(spec.value as GameSpecV1);
    const run = runBot(made.world);
    return <RulesReplay world={made.world} inputs={run.inputs} nodeHash={run.hash} />;
  }
  return <RulesLab fixture={f} world={made.world} />;
}
