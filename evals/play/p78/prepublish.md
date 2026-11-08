# P78 T7 – kontrola před zveřejněním (8. 11. 2026)

Jen čtecí kontroly; historie se nepřepisovala. Nálezy se tu necitují, jen soubor, commit a typ.

**Nad čím to běželo.** P77 ani P79 ještě nejsou v `main` (`origin/main` = `a741b5b4`, P76). Kontroly proto běžely nad větví P78 (`9fcfeb91` = `main` + P78 T1–T6) a nad všemi větvemi repozitáře (`rev-list --all`, 3 248 revizí). Po sloučení P77 a P79 se musí pustit znovu nad `main` – časy níž.

## Výsledek

| kontrola | výsledek | co dál |
|---|---|---|
| `blind-check` (všech 6) | **6/6 PASS** | po sloučení P77 a P79 znovu (~55 min) |
| gitleaks nad celou historií | **3 nálezy → 0** (testovací fixtury, `0e760a51`) | po sloučení znovu (~40 s) |
| gitleaks nad trackovaným stromem | **1 nález → 0** (tatáž fixtura) | – |
| `submission-check` (8 kontrol, plný běh) | **5 PASS, 3 FAIL**; kontrola 6 opravená (`532b09e6`) | zbývá repo (10. 11.) a video (P80) |

## `blind-check` – `BLIND_CHECK_HOOK=1 node scripts/blind-check.mjs origin https://github.com/Jerry-Crypto-7/Hackathon.git`

V režimu hooku, aby běžela i kontrola 5 (cíl pushe). 10:44–11:40, nad `9fcfeb91`.

| kontrola | výsledek |
|---|---|
| [1] identita commitů nenese autora | PASS |
| [2] lokální identita repa přebíjí globální | PASS |
| [3] obsah nezmiňuje organizátora ani skutečného autora | PASS |
| [4] `SECURITY-FINDINGS.md` nikdy nevstoupil do historie | PASS |
| [5] cíl pushe míří na anonymní účet | PASS |
| [6] do historie nevstoupily přihlašovací údaje ani surové artefakty běhů | PASS |

## gitleaks 8.30.0 (`--redact`)

**Historie** – `gitleaks detect --log-opts=--all`: 3 088 commitů, 257 MB, 3 nálezy pravidla `generic-api-key`. Tytéž tři jako v P74 T6 (`evals/play/p74/history-check.md`), od 7. 11. nepřibylo nic.

| soubor | řádek | commit | typ | v `HEAD` |
|---|---|---|---|---|
| `ops/env/tests/test_server.py` | 18 | `77c0a132` | klíč, který si test sám vytvoří a předá aplikaci pod testem | ano |
| `evals/worldstream/__tests__/measure-create.test.ts` | 678 | `c8a79b39` | falešný tvar klíče pro test detektoru tajemství | ne |
| `evals/worldstream/__tests__/measure-create.test.ts` | 917 | `f1c7e62e` | falešná adresa s klíčem na doméně `example` pro týž test | ne |

**Oprava v kódu (`0e760a51`):** `.gitleaksignore` s otisky těch tří nálezů a komentář `# gitleaks:allow` na řádku v `HEAD` (testy `ops/env` 19/19). Pak: historie **0 nálezů**, trackovaný strom (`git archive` indexu, 455 MB, `gitleaks dir`) **0 nálezů**.

`gitleaks dir .` nad pracovním adresářem hlásí 8 nálezů, ale prochází i netrackované `node_modules` (junction) a `test-results` – do klonu repozitáře se nic z toho nedostane.

Inference: ani jeden nález není skutečný přihlašovací údaj. Ověřeno jen z kódu kolem nich, hodnoty se nikde nezkoušely.

## `submission-check` – `node scripts/submission-check.mjs` (proti nasazené adrese)

| kontrola | výsledek |
|---|---|
| [1] veřejný repozitář je dostupný | **FAIL** – `repositoryUrl` odpověděla 504 |
| [2] hostovaný demo link odpovídá v prohlížeči | PASS |
| [3] demo video existuje a je pod 3:00 | **FAIL** – `videoPath` v `docs/submission/submission.json` je `TODO:` |
| [4] písemný popis existuje a není zástupný | PASS |
| [5] focus kategorie je zvolená a shodná s registrací | PASS |
| [6] disclosure je úplná napříč pěti třídami | **FAIL → opraveno** (níž) |
| [7] backend odpovídá a dostupnost se průběžně hlídá s alertem | PASS |
| [8] blind-check prošel | PASS |

**Kontrola 1 se z tohohle stroje ověřit nedá.** `fetch` z Node vrací 5xx i pro veřejné `https://github.com/openai/codex` (503), takže 504/502 je síť stroje, ne stav repa. Skutečný stav podle `gh repo view`: `visibility: PRIVATE`, výchozí větev `main`. Po zveřejnění 10. 11. ověřit z jiné sítě nebo v anonymním okně prohlížeče.

**Kontrola 6 – 15 nálezů, všechny opravené v `532b09e6`:**
- 2 vymyšlené identifikátory modelů v testech (`gpt-oss-test` v `src/app/api/play/__tests__/upgrade.test.ts`, `gpt-oss-20b-2508` v `src/server/__tests__/upstream-hosted.test.ts`) → položky první strany `kind: model`.
- 13 vlastních souborů nad prahem 4 096 B literálů (testy, měřicí skripty, `src/play/arcade/witness.ts`, `src/play/read/prompt.ts`, `scripts/quest-dev.mjs`) → cesty v položce první strany „vlastní zdroje nad prahem literálů“ (62 → 75 cest).
- Po opravě: `npm run gate:license` 7/7 (část a) a části b–d kontroly 6 přepočítané exportovanými funkcemi skriptu: 0 nálezů. Celý `submission-check` se znovu nepouštěl – kontrola 8 v něm znovu spouští `blind-check` (~55 min).

## Co zbývá před odevzdáním

- **Video ≤ 3:00** a jeho cesta ve `videoPath` (P80; `docs/submission/**` vlastní P79). Hlas, hudba a zvuky videa už v disclosure jsou (T6). Kdyby video použilo cokoli dalšího (přechod z Veo, zvuk z Pixabay), potřebuje to vlastní položku před odevzdáním.
- **Zveřejnit repo 10. 11.** (hlavní sezení na pokyn majitele), pak ověřit kontrolu 1 mimo tenhle stroj.
- **Po sloučení P77 a P79** znovu nad `main`: `blind-check` v režimu hooku (~55 min), gitleaks nad historií (~40 s) a `submission-check` (~55 min). Cíl: 8/8 po doplnění videa a zveřejnění.
- AI verze dema dál `MODEL_UNAVAILABLE` – chybí klíče ve Vercelu (T4, `evals/play/p78/ai-live.md`).
