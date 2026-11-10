# P83B T1 – proč „garbled“ a proč 180 s (10. 11. 2026)

**Odpověď nahoře:**
- **„Garbled“ není rozbitá odpověď.** Model vrátil celý platný JSON (`finish_reason: stop`). Čtečka ale zahodila celou hru kvůli jednomu poli: věta říká „three“, model napsal `counts.collectible: 3` a vybral pohyb `walk` (bludiště). Bludiště počet sbíraných věcí nebere a čtečka každý takový počet bere jako vadnou odpověď (`src/play/director/read.ts:113–115`). Žádné opravné kolo se nespustí, hráč hned dostane „came back garbled“. Stalo se to u 2 ze 3 vět (rytíř, obchod).
- **Pomalost dělají volání modelu, ne fronta ani kontrola.** Jedno volání režiséra trvá 22–27 s. Kulička udělala dvě taková volání a čtyři opravná kola, celkem 95 s, a hráč přitom 57 s viděl „Fixing one thing…“.
- **Opakovaná věta dostane starou chybu.** Verdikt `MALFORMED` se ukládá na hodinu jako „verdikt o větě“ (`_upgrade.ts`, `SENTENCE_VERDICTS`), proto soud viděl „garbled“ u opakování už za 31 s a na telefonu za 7 s. To řeší T4.

## Jak se měřilo

- Místní `next start` na portu 3212 se stejným režisérem jako produkce: astra (`gpt-6-astra`) přes placené OpenAI API, kompaktní první odpověď, čtečka věty zapnutá. Úložiště, cache režiséra i kniha útraty jen v paměti procesu – produkce se nedotkla.
- Věty soudu přeformulované, aby minuly cache režiséra:
  - rytíř: „A knight gathers three golden keys inside a castle while a dragon guards the great hall“
  - kulička: „A marble rolls down a slope, topples a line of dominoes, and the final domino rings a bell“
  - obchod: „In a little shop I grab three items, set them on the counter, and see the total price“
- Každé volání OpenAI zapsal záznamník v procesu serveru (čas, `finish_reason`, tokeny, délka odpovědi). Klient se ptal na `…/upgrade` každé 2 s jako stránka.
- První běh kuličky a obchodu narazil na můj místní strop útraty (1,5 USD, rezervace jednoho volání je ~1 USD) a skončil `MODEL_UNAVAILABLE` bez volání. Opakoval jsem je na novém serveru se stropem 3 USD; do výsledků jde až druhý běh.

## Výsledky

| Věta | Konec | Čas od odeslání | Volání modelu | Útrata (ceník) |
|---|---|---|---|---|
| rytíř | `MALFORMED` | 32,7 s | čtení + 1 režie | 0,59 USD |
| kulička | AI verze hotová | 94,6 s | čtení + 2 režie + 4 opravná kola | 1,43 USD |
| obchod | `MALFORMED` | 35,0 s | čtení + 1 režie | 0,60 USD |

## Časová osa (sekundy od začátku pokusu na serveru)

**Rytíř** – 27,6 s do konce:
- 0,4–4,3 čtení věty (3,9 s)
- 5,0–27,6 režisér (22,5 s; vstup 51 426 tokenů, výstup 783, z toho 162 uvažování)
- 27,6 čtečka odpovědi: `MALFORMED_SPEC – counts.collectible: unsupported or out of bounds for walk` → konec

**Kulička** – 91,3 s do konce:
- 0,2–7,1 čtení věty (6,9 s)
- 7,6–32,4 režisér (24,9 s)
- 33,2–38,1 a 38,2–44,7 dvě opravná kola (5,0 s a 6,5 s; odpovědi 17 a 7 znaků – prázdná záplata, nic neopravila)
- 46,7–71,7 druhý pokus režiséra s pokynem „přidej bosse nebo akci“ (`ADD_NUDGE`, 25,0 s) – první verze nic nepřidala
- 72,3–81,5 a 81,5–89,2 další dvě opravná kola (9,2 s a 7,7 s)
- 91,3 publikace hotová
- Hráč viděl „Fixing one thing…“ od 37,7 s do 94,6 s.

**Obchod** – 32,5 s do konce:
- 0,1–5,0 čtení věty (4,8 s)
- 5,2–32,5 režisér (27,3 s)
- 32,5 tatáž chyba čtečky jako u rytíře → konec

**Kde stojí čas:**
- Fronta na slot: 0 s (vždy jedna věta naráz).
- Čtení věty: 3,9–6,9 s.
- Volání režiséra: 22,5–27,3 s. Vstup má 51,4 tis. tokenů, z toho schéma odpovědi 374 596 znaků (`GENRE_ANSWER_SCHEMA`, všechny žánry). Placená cesta posílá celé schéma, i když model ve všech 4 odpovědích odpověděl receptem; cesta přes codex-cli posílá jen užší schéma receptu (`codexOutputSchema`).
- Opravné kolo: 5–9 s, vstup ~6 tis. tokenů.
- Kontrola výhry robotem a zápis: mezery mezi voláními 0–2,1 s.

## Tvar chyby (bez celé odpovědi)

Rytíř i obchod: odpověď `{plan, spec}` s receptem `move: "walk"`, `objective: "collect"`, obsazení z věty (hrdina, sbíraná věc, hlídač) a `counts: { enemy: null, collectible: 3, target: null }`. Strict schéma OpenAI chce všechna pole, takže model počet z věty („three“) poctivě vyplní. Čtečka nativních receptů (`readRecipeContent`) přijme jen `counts.target` u míčové hry; cokoli jiného odmítne celou odpověď.

## Soud na produkci: 180 s

**Odvozeno, ne změřeno na produkci:** místně trvala kulička 95 s se dvěma voláními režiséra a čtyřmi opravnými koly. Na produkci jde každé volání s prázdnou cache promptu (místně měl druhý a další dotaz 51 tis. tokenů z cache), a soudcův prohlížeč běžel na přetíženém stroji. Stejný řetěz (dvě režie + opravná kola) na pomalejších voláních dává 150–200 s. Strop 45 s (T3) tenhle řetěz utne bez ohledu na rychlost volání.
