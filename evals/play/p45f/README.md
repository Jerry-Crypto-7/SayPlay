# P45F – druhý pokus o jména, která v P45E neprošla

Plán: P45F (interní). Větev převzala fast-forwardem `features/P45E-generovani-modelu-2026-10-08` (`52fb322b`, PR #31) – slučuje se **po P45E**.

## Odkud jsou jména

- `evals/play/p45e/gen-round.md` – 60 jmen, která v P45E neprošla předkontrolou obrázku, branou kvality nebo slepým soudem, a co v obrázku místo nich viděl Codex (oddíly „Soudce poznal něco jiného“ a „Předkontrola odmítla všechny tři obrázky“ v T4 i dávkách T5).
- Zjištění P45E: ruční rozlišovací znak v `ops/gen3d/features.toml` mělo ze zbytku T5 jen 1 z 39 jmen; úspěšnost soudu T5 18 % proti 42 % u T4. P45F proto každému neprošlému jménu píše znak podle toho, co soudce viděl místo něj, a nic jiného na generátoru nemění.
- Mimo: lizard, demon, wolf (soud prošel, povýšení narazí na testy v `src/play`), dynamite (LOD1), nová jména, kód generátoru.

## Okno a strop

- Karta RTX 3090 sdílená s P45B, každý běh přes `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`.
- Po **9. 10. 2026 09:15** se nová dávka nespouští; rozběhnutá se dokončí, hotové se povýší, zbytek se zapíše do `gen-round.md`.
- Codex na předplatné: strop celého P45F **150 volání** (předkontrola + slepý soud). Vyčerpaný limit = zbylá jména „čeká na soud“, běh končí.
