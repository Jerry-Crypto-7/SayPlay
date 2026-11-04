# P70B T4a – AI verze do 120 s v lokálním demu (4. 11. 2026)

**3 ze 4 nových vět dostaly AI verzi do 120 s (v T4 1 ze 3).** Čtvrtá (tučňák) ztratila 40 s na chybě backendu
„Selected model is at capacity“ a dorazila po limitu, se třemi novinkami.

Stejný profil jako T4: codex-cli na předplatném (`gpt-6-astra`, úsilí `medium`), `next start` na :3202, `live.mjs --out`.

## Co se změnilo

- **Užší schéma pro codex** (`f320f615`): jen recept, bez 28 legacy variant – recept pokryje každý žánr, který
  varianty nabízely (test v `recipe-answer.test.ts`). Naměřeno přímým voláním (auto na trati): 24,8 s a 22 tis.
  vstupních tokenů proti 40,1 s a 66 tis. Ostatní poskytovatelé dostávají plné schéma beze změny.
- **Druhý běh s pokynem jen se zbývajícím časem** (`4c2f502b`): spustí se, jen když uplynulý čas + délka prvního
  běhu nepřesáhne 120 s. Jinak se publikuje první AI verze s `adds: []`.

## Naživo

| věta | AI verze za | volání režiséra | novinka |
|---|---|---|---|
| a cowboy shoots bottles off the fence | 103 s ✓ | 3 (37 s + opravy 19 s, 30 s) | boss |
| a chef catches falling pizzas in the kitchen | 63 s ✓ | 3 (chyba kapacity 3 s, 28 s, druhý běh s pokynem 21 s) | žádná |
| a frog hops across a busy road | 99 s ✓ | 3 (27 s + opravy 29 s, 27 s), druhý běh přeskočen | žádná |
| a penguin slides down an icy hill | po 120 s ✗ | chyba kapacity 40 s, 29 s, oprava 16 s | boss, akce, úseky |

- První volání teď trvá 27–37 s (v T4 35–52 s) s 22 tis. vstupními tokeny místo 66 tis.
- Golf, auto a nindža z T4 přišly za 17–27 s bez jediného volání – odpověď už byla v cache z T4, proto se
  do výsledku nepočítají (`live-cached.json`, snímky nejsou).
- Volání předplatného v T4a: 14 (2 přímá měření + 12 živě), strop 20.

## Cena

U žáby se druhý běh přeskočil a AI verze vyšla bez novinky; kuchař novinku nedostal ani po druhém běhu. Rychlost
tu jde proti novince: druhý běh trvá aspoň jedno volání režiséra (21–37 s), žába by s ním skončila přes 120 s.
