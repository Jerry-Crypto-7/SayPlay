import { CreateGame } from '@/components/play/CreateGame';
import { Feed } from '@/components/play/Feed';
import { HERO, SUBHEAD } from '@/components/play/starters';
import { ARCHETYPES } from '@/play/registry';

/** Věty archetypů pro karty feedu – registr zůstává na serveru. */
const PITCHES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(ARCHETYPES).map(([id, archetype]) => [id, archetype.pitch]));

/** `/play` – věta dovnitř, odkaz na hru ven. Formulář a feed jsou klientské, hero statické. */
export default function PlayPage() {
  return (
    <main className="play-create">
      <h1 className="play-hero">{HERO}</h1>
      <p className="play-subhead">{SUBHEAD}</p>
      <CreateGame />
      <Feed pitches={PITCHES} />
    </main>
  );
}
