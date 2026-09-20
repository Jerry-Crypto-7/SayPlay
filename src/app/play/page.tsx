import { CreateGame } from '@/components/play/CreateGame';
import { HERO, SUBHEAD } from '@/components/play/starters';

/** `/play` – věta dovnitř, odkaz na hru ven. Formulář je klientský, hero statické. */
export default function PlayPage() {
  return (
    <main className="play-create">
      <h1 className="play-hero">{HERO}</h1>
      <p className="play-subhead">{SUBHEAD}</p>
      <CreateGame />
    </main>
  );
}
