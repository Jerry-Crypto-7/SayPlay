/**
 * Karta mezi koly řetězu (P56C T11): sloveso dalšího kola („Catch!“) a „Round 2/5“. Leží nad zamrzlým koncem
 * předchozího kola; stisky během ní relace řetězu zahodí, takže karta je jen obraz.
 */

export function ChainCard({ card, round, rounds }: { readonly card: string; readonly round: number; readonly rounds: number }) {
  return (
    <div className="play-chain-card-frame">
      <section className="sp-card play-chain-card" data-testid="play-chain-card" data-round={round} role="status" aria-live="polite">
        <p className="play-chain-card-round">
          Round {round}/{rounds}
        </p>
        <p className="sp-display-m play-chain-card-verb">{card}</p>
      </section>
    </div>
  );
}
