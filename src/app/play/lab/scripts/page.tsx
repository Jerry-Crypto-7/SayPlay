import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { ScriptsLab } from './ScriptsLab';

/**
 * `/play/lab/scripts` – zkušební sada skriptů úrovní (P68 T13): Chromium a WebKit spustí tytéž programy v QuickJS
 * a e2e `p68-scripts` porovná výstup s Node bajt po bajtu. Mimo vývoj jen s `PLAY_LAB=1`, jinak 404 – porotce na ni
 * nemá narazit. QuickJS se načte jen tady (a na serveru při AI verzi), nikdy na cestě rychlé hry.
 */
export default async function ScriptsLabPage() {
  await connection();
  if (process.env.NODE_ENV === 'production' && process.env.PLAY_LAB !== '1') notFound();
  return <ScriptsLab />;
}
