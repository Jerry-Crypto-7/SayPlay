# P45F – druhý pokus o jména, která v P45E neprošla

Plán: P45F (interní). Větev převzala fast-forwardem `features/P45E-generovani-modelu-2026-10-08` (`52fb322b`, PR #31) – slučuje se **po P45E**.

## Odkud jsou jména

- `evals/play/p45e/gen-round.md` – 60 jmen, která v P45E neprošla předkontrolou obrázku, branou kvality nebo slepým soudem, a co v obrázku místo nich viděl Codex (oddíly „Soudce poznal něco jiného“ a „Předkontrola odmítla všechny tři obrázky“ v T4 i dávkách T5).
- Zjištění P45E: ruční rozlišovací znak v `ops/gen3d/features.toml` mělo ze zbytku T5 jen 1 z 39 jmen; úspěšnost soudu T5 18 % proti 42 % u T4. P45F proto každému neprošlému jménu píše znak podle toho, co soudce viděl místo něj, a nic jiného na generátoru nemění.
- Mimo: lizard, demon, wolf (soud prošel, povýšení narazí na testy v `src/play`), dynamite (LOD1), nová jména, kód generátoru.

## Seznam a znaky (T2)

- `retry-nouns.json` – **58** z 60 neprošlých jmen P45E, podle počtu vět v `evals/play/p45d/missing.json`, pak abecedně (19 jmen má 1–2 věty, zbytek 0). Každé nese třídu ze vstupu P45E a co soudce viděl místo něj. Třídu jsme opravili u tří jmen, kde šablona zadání kreslila něco jiného: broomstick flyer → prop (šablona „wings spread wide“ dala čarodějnici), peacock flyer → prop (roztažený vějíř ocasu třikrát neprošel bránou kvality), moon rover prop → vehicle.
- `ops/gen3d/features.toml` – ruční znak pro všech 58 (oddíl „P45F“), komentář `# P45E:` nese, co soudce viděl. Znaky jen přepsané nebo nové, kód generátoru beze změny.
- **cyclops nikdy znak nedostal:** dávka jméno normalizuje na „cyclop“ (`ops/gen3d/cache.py`, množné číslo), `batch.prompt_for` hledá znak pod normalizovaným klíčem, takže `cyclops = …` z P45E se do zadání nepřipsal. Klíč je teď `cyclop`, stejně `canva` pro canvas.
- **Vyřazeno (2):**
  - mane – část zvířete, ne samostatná věc: sama hříva vyjde jako věnec nebo šiška (P45E), se zvířetem by soudce viděl lva.
  - fuel – látka; nádobu kreslí od P45E `gen3d-fuel-can`, patří mezi synonyma, ne nový model.

## Okno a strop

- Karta RTX 3090 sdílená s P45B, každý běh přes `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`.
- Po **9. 10. 2026 09:15** se nová dávka nespouští; rozběhnutá se dokončí, hotové se povýší, zbytek se zapíše do `gen-round.md`.
- Codex na předplatné: strop celého P45F **150 volání** (předkontrola + slepý soud). Vyčerpaný limit = zbylá jména „čeká na soud“, běh končí.
