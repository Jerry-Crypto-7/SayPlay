import Link from 'next/link';

/** Neznámá nebo vypršelá hra: jedna věta a cesta k nové. Stav 404 nastaví `notFound()`. */
export default function GameNotFound() {
  return (
    <main className="play-create">
      <h1 className="play-hero">Game not found</h1>
      <p className="play-subhead" data-testid="play-not-found">This game does not exist or has expired.</p>
      <p>
        <Link className="play-button" href="/play">
          Make a new game
        </Link>
      </p>
    </main>
  );
}
