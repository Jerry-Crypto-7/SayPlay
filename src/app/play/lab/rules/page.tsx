import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import carryKey from '@/play/arcade/__fixtures__/rules/carry-key.json';
import collectGate from '@/play/arcade/__fixtures__/rules/collect-gate.json';
import giveFlower from '@/play/arcade/__fixtures__/rules/give-flower.json';
import leverBridge from '@/play/arcade/__fixtures__/rules/lever-bridge.json';
import pushCrate from '@/play/arcade/__fixtures__/rules/push-crate.json';
import throwRock from '@/play/arcade/__fixtures__/rules/throw-rock.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { readGameSpec, type GameSpecV1 } from '@/play/spec';

import { RulesLab } from './RulesLab';

const FIXTURES: Readonly<Record<string, unknown>> = {
  'carry-key': carryKey,
  'collect-gate': collectGate,
  'give-flower': giveFlower,
  'lever-bridge': leverBridge,
  'push-crate': pushCrate,
  'throw-rock': throwRock,
};

/**
 * `/play/lab/rules?f=<fixture>` – ruční hra pravidel, kterou přehraje robot
 * (P29A T6), aby e2e viděla nesenou, hozenou a přepnutou věc. Svět se
 * překládá tady (překlad potřebuje `node:crypto`), klient ho jen hraje.
 * Mimo vývoj jen s `PLAY_LAB=1`, jinak 404 – porotce na ni nemá narazit.
 */
export default async function RulesLabPage({ searchParams }: { readonly searchParams: Promise<{ readonly f?: string }> }) {
  await connection();
  if (process.env.NODE_ENV === 'production' && process.env.PLAY_LAB !== '1') notFound();
  const { f } = await searchParams;
  if (f === undefined || !Object.hasOwn(FIXTURES, f)) notFound();
  const spec = readGameSpec(FIXTURES[f]);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const made = arcadeWorldOf(spec.value as GameSpecV1, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return <RulesLab fixture={f} world={made.world} />;
}
