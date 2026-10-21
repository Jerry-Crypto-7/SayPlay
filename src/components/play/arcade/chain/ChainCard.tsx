/**
 * Karta mezi koly řetězu (P56C T11): sloveso dalšího kola („Catch!“) a „Round 2/5“, pod slovesem mutátor kola
 * („Mirror!“, T16). Leží nad zamrzlým koncem předchozího kola; stisky během ní relace řetězu zahodí, takže karta je jen obraz.
 */

export function ChainCard({ card, twist, round, rounds }: { readonly card: string; readonly twist?: string | undefined; readonly round: number; readonly rounds: number }) {
  return (
    <div className="play-chain-card-frame">
      <section className="sp-card sp-tilt-l play-chain-card" data-testid="play-chain-card" data-round={round} role="status" aria-live="polite">
        <p className="play-chain-card-round">
          Round {round}/{rounds}
        </p>
        <p className="sp-display-m play-chain-card-verb">{card}</p>
        {twist !== undefined && (
          <p className="play-chain-card-twist" data-testid="play-chain-twist">
            {twist}
          </p>
        )}
      </section>
    </div>
  );
}
