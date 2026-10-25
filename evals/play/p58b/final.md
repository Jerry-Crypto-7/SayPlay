# P58B T8 – zapečetěná sada žánru, otevřena jednou

Čísla: `final.json`, čtení `readings/holdout.astra.json`, otevření `holdout-opened.json`. Měřeno 25. 10. na commitu `d0cc66d1` (`holdout.measure.ts`), čtečka astra (`gpt-6-astra`, úsilí `low`, OpenAI API z lokálního PC, cesta AI verze, rozpočet 15 s), semínko 1. Nic se podle výsledku neladilo.

## Výsledek

| brána | cíl | AI verze (čtení astry) | rychlá hra (slovník + pravidlo T5) |
|---|---|---|---|
| cíle: správný žánr | ≥ 48/60 | **60/60** ✅ (i režim 60/60) | 25/60 ❌ |
| pasti: nehraje lákavý žánr | ≥ 18/20 | **20/20** ✅ (přísněji bez lákavého žánru 19/20) | 15/20 ❌ |
| robot vyhraje | 80/80 | **80/80** ✅ | – |
| nečinný hráč prohraje | 80/80 | **80/80** ✅ | – |
| replay sedí | 80/80 | **80/80** ✅ | – |
| čtečka p50 / p95 | ≤ 700 / ≤ 1 000 ms | 2,7 s / 5,5 s (max 6,5 s) – neplatí, viz níže | – |
| čtení vypršelo | 0 | 0 z 80 – běh platí | – |

- **Brána AI verze je splněná.** Žánr AI verze rozhoduje čtení dřív, než se zavolá režisér (T5, T5a), proto ji měří čtečka a návrh se čtením, ne volání režiséra (to by stálo ~50 USD).
- **Latence:** astra čte jen pro AI verzi na pozadí, hranici 1 000 ms nesplní žádný změřený hostovaný model (rozhodnutí T3). Rychlá hra na čtení nečeká.
- **Slova věty ve specu AI verze:** hrdina 58/59, protivník 41/43, věc 23/25, svět 73/74.

## Rychlá hra – brána nesplněná

- Rychlá hra (hratelná do 2 s) bere žánr jen ze slovníku. Na nové sadě trefí 25/60 cílů a 15/20 pastí.
- Ze 35 minutých cílů skončilo 11 v aréně, 10 v úkolu, 8 v plavbě a 4 v běhu. Slovník u vět bez známého slova padá do obecných žánrů.
- Hráč tak u ~60 % vět dostane nejdřív hru jiného žánru a správný žánr přijde až s AI verzí (T7: p50 57 s).

## Co dál

- **Rychlou hru zachrání jen rychlejší čtení.** Slovník přepisovat podle této sady nejde (sada je otevřená, ladit se na ní nesmí). Kandidáti: čtečka pod 1 s (žádný hostovaný model z T3 to neumí; lokální model na GPU P30 vyloučil), nebo přechod z rychlé hry na AI verzi hned, jak dorazí čtení (2,7 s), dřív než celá AI verze.
- **Výhrada (odvozeno):** 60/60 a 20/20 je nad dev (T6: 120/120, 40/40) i nad čekáním. Sadu psal Codex podle popisů režimů z pohledu hráče a prompt čtečky popisuje žánry stejně, takže číslo může být k tomuto stylu vět štědřejší. Skutečné věty hráčů změří P59.

## Útrata T8

~2,2 USD (81 čtení × ~0,027 USD odhadem z T3; strop čtečky 4 USD). Plus ~0,1 USD za běh nanečisto na 4 otevřených větách P56A.
