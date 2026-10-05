import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { PhysicsLab } from './PhysicsLab';

/**
 * `/play/lab/physics` – zkušební scéna Rapieru pro e2e (P29A T11): Chromium
 * spočítá tentýž hash jako Node. Mimo vývoj jen s `PLAY_LAB=1` (e2e ho nastaví
 * serveru), jinak 404 – porotce na ni nemá narazit.
 */
export default async function PhysicsLabPage() {
  await connection();
  if (process.env.NODE_ENV === 'production' && process.env.PLAY_LAB !== '1') notFound();
  return <PhysicsLab />;
}
