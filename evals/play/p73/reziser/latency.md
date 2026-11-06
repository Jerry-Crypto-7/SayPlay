# P73C T1 – kolik času dělá schéma režiséra

**Datum:** 6. 11. 2026. **Poskytovatel:** codex-cli na předplatném ChatGPT (cesta `.claude/start-demo.cmd`), model gpt-6-astra, effort medium. **Groq:** `reached:false` – klíč `GROQ_API_KEY` v prostředí není. **Tato čísla nejsou Groq.**

**Skript:** `scripts/play/p73-schema-latency.mjs`, surová data `latency.json`. 20 nových vět (`sentences.txt`, celé věty nikde v repu), první volání režiséra přes skutečné `direct()` bez cache a bez opravného kola, varianty prokládaně A,B / B,A, dvě volání souběžně.

## Výsledek (fakta)

| Varianta | Volání | Celkový čas p50 | p90 | Vstup tokenů p50 | Výstup p50 | Prošlo čtením | Prošlo kritikem i robotem |
|---|---|---|---|---|---|---|---|
| (a) dnešní schéma (21 712 znaků, 151 hodnot výčtů) | 20 | 41,1 s | 52,9 s | 22 075 | 800 | 20/20 | 5/20 |
| (b) výčty zúžené podle věty (21 066 znaků, 76 hodnot) | 20 | 37,0 s | 65,6 s | 21 888 | 749 | 18/20 | 3/20 |
| (c) bez schématu, strop úspory (6 vět) | 6 | 40,8 s | 86,0 s | 18 931 | 736 | 0/6 | 0/6 |

- **Čas do prvního tokenu nejde na této cestě změřit:** `codex exec --json` pošle hotovou zprávu až na konci kola (jediná událost před ní je varování codexu do 1 s). Pole `firstItemDoneMs` v `latency.json` proto není čas prvního tokenu.
- „Prošlo kritikem i robotem“ bez opravného kola; v provozu má režisér opravná kola, takže čísla jsou jen srovnání variant, ne úspěšnost AI verze.

## Co z toho plyne (odvozeno)

- **Předpoklad plánu neplatí:** schéma, které odchází na codex-cli, nemá výčet z katalogu (~2 200 hodnot). Má 151 hodnot výčtů a kolem 3 100 tokenů z 22 000 vstupu. Velký je hlavně systémový prompt (14,5 tis. znaků).
- **Schéma režiséra nebrzdí:** bez schématu vůbec je medián stejný (40,8 s proti 41,1 s). Čas dělá generování odpovědi (~800 tokenů výstupu včetně přemýšlení) a režie volání.
- **Zúžení výčtů zrychlí medián o 10 %, ne o 30 %,** a horší je p90 (65,6 s) i kvalita (čtení 18/20 proti 20/20, kritik 3/20 proti 5/20).
- **T3: nezapnuto.** Brána plánu (≥ 30 % mediánu a kvalita aspoň stejná) neprošla ani v jednom bodě.
- **Neměřená cesta Groq:** hostovaný poskytovatel dnes dostává plné `GENRE_ANSWER_SCHEMA` (399 618 znaků, 3 181 hodnot výčtů), ne recept jako codex-cli. Tam může být schéma brzda i cena; ověřit až s klíčem.
