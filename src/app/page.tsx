/**
 * Hlavní adresa vede na PLAY (P25B T7). Stará aplikace WORLDSTREAM žije na
 * `/studio`. Přesměrování je v serverové komponentě (307), ne v
 * `next.config` – ten tahle větev nevlastní.
 */

import { redirect } from 'next/navigation';

export default function Home(): never {
  redirect('/play');
}
