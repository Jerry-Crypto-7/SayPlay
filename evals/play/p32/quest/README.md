# Úkol – sloveso mění předmět před očima (P32G T6)

Věty hasiče, čaroděje a kuchaře z přijímací sady P32 (rychlá verze:
`questGenre.draftFill` bez modelu → `compileGenre`; kuchař „A chef cooks pancakes“
prostředí nemá, test doplní „kitchen“), na desktopu (1280×720) a na Pixel 7
(412×839, CPU 4× pomalejší). Na snímku je jen plátno hry, bez HUD.

Ukázka robota („Show me how“) se přehraje jednou a sonda vrstvy cílů
(`data-quest` na plátně) řekne tik, kdy se předmět posunul. Druhá ukázka se
zastaví 10 tiků před ním (`before`) a 30 tiků po něm (`after`).

- `firefighter` – strom hoří (plameny nad korunou, žár) → po zásahu začouzený a kouří.
- `wizard` – svíčka nezapálená → hoří plamínkem se září; duchové v záběru.
- `chef` – stanoviště zblízka: kamera nad pultem, hrdina za ním. Před: syrové těsto,
  mátový kruh = „drž Use teď“. Po: první palačinka zlatá, druhá pánev se peče
  (modrý plyn, rudý kruh = okno připravenosti ještě zavřené).

```
FALLBACK_SMOKE_URL=http://127.0.0.1:3357 node scripts/p32/heavy.mjs -- npx playwright test e2e/p32-quest.spec.ts
```

## Měření 30. 9.

| Snímek | Posun (tik) | Stavy před → po | Hrdina (výška obrazu) | Duch v záběru |
|---|---|---|---|---|
| hasič desktop | 89 | 0 → 1 | 9,5 % | – |
| čaroděj desktop | 87 | 0 → 1 | 8,1–8,4 % | před i po |
| kuchař desktop | 31, 122 | 0 → 2 | 26,9 % | – |
| hasič Pixel 7 | 91 | 0 → 1 | 8,6 % | – |
| čaroděj Pixel 7 | 89 | 0 → 1 | 4,7–4,9 % | jen před |
| kuchař Pixel 7 | 34, 123 | 0 → 2 | 17,5 % | – |

Robot vyhraje všechny tři. Okno připravenosti kuchaře bylo v ukázce zavřené i otevřené.
FPS Pixel 7 se 4× CPU (medián): hasič 54, čaroděj 42, kuchař 54. Fialová na žádném snímku.
