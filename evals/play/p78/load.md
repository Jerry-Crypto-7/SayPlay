# P78 T5 – provoz do 31. 12. 2026 (8. 11. 2026)

## (a) Hlídač dostupnosti

**Zjištění:** UptimeRobot byl jen záznam v `ops/monitoring/uptime.json`. V repu nebyl žádný účet, klíč ani `.github/`, takže externí hlídání ve skutečnosti neběželo.

**Náhrada:** `.github/workflows/health-probe.yml` – každých 10 minut (a ručně) ověří `/`, `/api/health`, `/play` a `/api/build-id`. Odpověď jiná než 200 (po dvou opakováních) otevře issue „Demo down: health probe failed“, další pády do něj přidají komentář a běh zčervená. Token smí jen číst repo a psát issues. `uptime.json` → `external` teď popisuje tenhle workflow a stejné čtyři adresy; kontrola [7] v `scripts/submission-check.mjs` je přijímá (interval 10 min ≤ 15 min).

Test: `scripts/__tests__/health-probe-workflow.test.ts` – interval, cíle shodné s `uptime.json`, issue a červený běh při pádu, práva tokenu. Ověřil jsem ho třemi záměrnými chybami ve workflow (chybějící cíl, `exit 0` místo `exit 1`, `contents: write`); každá test shodila.

**Kdy začne běžet:** až bude workflow v `main` na GitHubu – naplánované workflow běží jen z výchozí větve. Na soukromém repu by `*/10` spotřebovalo ~4 300 minut Actions měsíčně, víc než bezplatných 2 000. Po zveřejnění repa 10. 11. jsou minuty zdarma. Lokálně workflow spuštěný nebyl (`curl` v tomhle prostředí neběží); první skutečný běh ukáže záložka Actions.

## (b) Zátěž: 20 souběžných návštěvníků

`scripts/play/p78-load.mjs` → `evals/play/p78/load.json`. Produkce, strom `4e176d1f`, 8. 11. 2026 09:04 UTC. 20 vět naráz, každá jiná, jen rychlá verze. Návštěvník pošle větu a otevře hru. Všechno šlo z jedné IP adresy.

| | hodnota |
|---|---|
| úspěšní návštěvníci | **20 / 20**, 0 chyb, všechny `201` |
| vytvoření hry (`POST /api/play/games`) | p50 5,9 s · p95 8,2 s · max 8,9 s |
| vytvoření + otevření hry | p50 6,5 s · **p95 8,6 s** · max 9,3 s |

Pro srovnání: jedna věta v T1 trvala do adresy hry p50 2,0 s. Pod souběhem 20 se vytvoření hry zpomalí asi třikrát, ale nic nespadne a žádný limit nezasáhl. AI verze se nevolala (klíče chybí, `MODEL_UNAVAILABLE`, útrata 0 USD).

## (c) Životnost sdílených her

`PLAY_VERSION_TTL_SECONDS` v produkci nastavená není (`vercel env ls production` ji nevypisuje), platí tedy výchozích **180 dní od publikace** (`src/play/version/store.ts`). Hra z 11. 11. 2026 vydrží do května 2027, hra z 24. 9. 2026 (první den sdílení, kdy výchozí hodnota vznikla) do března 2027. **31. 12. je pokrytý, žádná proměnná se nastavovat nemusí.** Úložiště je Upstash (`KV_REST_API_*` v produkci jsou), takže hry přežijí restart i nové nasazení.

Denní strop publikací `PLAY_PUBLISH_DAILY_CAP` (výchozí 500 her za den) v produkci také nastavený není. Nad ním dveře odpoví `429 PUBLISH_QUOTA`.

## (d) Runbook

`docs/ops/runbook.md` (anglicky) popisuje, co dělat při výpadku Upstash, OpenAI, při limitech Vercelu a vyčerpaném stropu a jak nasadit znovu a vrátit nasazení. Je bez tajemství a bez interní strategie.
