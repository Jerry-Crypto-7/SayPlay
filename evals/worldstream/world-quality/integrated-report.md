# P20 T18 — aktuální hybridní série

Verze harnessu `p20-t18-hybrid-v1`, start 17. 9. 2026. Běh: `plans/P20/t18-hybrid-20260917-1624/`. Tento dokument odkazuje na nový archiv; historická T01 baseline se nepřepisuje.

**RUNNING; produktové brány PENDING.** Autoritativní průběžný stav je `results.json` (od startu všech 30 řádků) a `summary.json`; konec označí `completion.json`. Žádný chybějící případ nebo čas se nemění na PASS či nulu.

**Průběžný prokázaný FAIL G-R:** při 16 dokončených případech jsou pouze 4 certifikované blueprinty. I kdyby všech 14 zbývajících prošlo, horní mez je 18/30, pod požadovanými 27/30. Browser může tuto mez pouze snížit. Běh přesto pokračuje na plném denominatoru; ostatní pending důkazy se nemění na PASS. Původní strojový `summary.json` stále používá obecný PENDING_BROWSER label zmrazeného harnessu; tento odstavec vysvětluje silnější závěr, nikoli přepis raw dat.

## Rozsah a původ

- Původní locked 10 development + 20 holdout, seed4021; žádná změna promptů/thresholdů ani tuning podle holdoutu během běhu.
- Jeden již autorizovaný codex-cli transport, GPT-6 Astra, medium, standardní rychlost, sekvenčně. Max90calls =30 planner +max60 compiler. Compiler max2 pokusy, transport240s/call, runner6h10min. Není vlastní180min cutoff, automatický retry model-call ani nové účty/kredity. Nominální subscription účetní jednotky nejsou cena v USD.
- Snapshot relevantních model/IR/sim/verify/scene/geom/shape/worldstream/assets/server a eval souborů v `source/`; `environment.json` má jejich SHA256, git commit/dirty diff hash, locked dataset hashes a Node/OS/CPU. Před prvním callem je ověřeno, že soubory během snapshotu nezměnily obsah. Vitest používá načtené moduly tohoto běhu; pozdější UI práce není jeho novou modelovou verzí.
- `raw/<id>-<call>.json` se zapisuje před callem i po něm: celý request, kompletní upstream result včetně těla/usage/failure a elapsed čas. Existující transport u neparsovatelného CLI výstupu původní stdout nevydává; zůstává přesný vrácený failure, nikoli vymyšlená raw odpověď. Snapshoty ani archiv nečtou credential stores.
- Planner result, každý compiler outcome/round, fase timing a finální failure zůstávají v archivu. Certifikovaný blueprint je uložen pod `hybrid/<id>.json` ve formátu existující galerie. `compiled` je certifikovaný serverový blueprint, nikoli browser live či vizuální úspěch.
- Malformed model odpověď je odmítnutí případu bez automatického retry. Nedostupnost/odmítnutí transportu zastaví další volání, zaznamená incomplete a ponechá zbývající řádky pending.

## Oddělené přejímky

### Nový samostatný A4 modelový běh — v2

Pozdější oddělené měření `plans/P20/a4-live-v2-20260917-1756/` dokončilo 10/10 živých modelových intervencí nad explicitními ručními fixtures: 8/8 nečasovačových a 2/2 timer. Historický v1 zůstává 7/10. V2 změnila produktový behavior prompt kontrakt a a05 lever→gate fixture; stochastický rerun není kontrolovaný kauzální experiment. Model transport p95 10 304,522 ms, lokální commit 106,254 ms, lokální replay 258,166 ms (nearest-rank n=10, replay zahrnuje opakování). 13/13 fork/oracle/determinism checks a 10/10 nezměněných vstupních blueprintů. Souběžná T18 zátěž unknown. Žádný HTTP/browser/host nebo nezávislý queue/RNG důkaz; lidské rozpoznání 3/5 PENDING. Úplný report a odvozené hodnoty v uvedeném archivu. Následující původní odstavec popisuje stav v okamžiku startu T18, nikoli tento pozdější oddělený běh.

Existující10A4 místní fixture replay je referencí/hash v environmentu, nebyl znovu spuštěn a neznamená10živých modelových intervencí. Nebyly přidány další model edit calls.

Cold/warm/neobvyklý nový asset: **unknown/pending**, nelze je odvodit ze serverové doby. Prompt-to-first-visible a browser live časy zůstávají null. G-V/G-W lidské hodnocení, G-P cílový notebook/GPU, G-E nové provider objekty a G-D veřejný host/registrační/video důkaz zůstávají pending.

Lokální testy před startem:5/5 budget/report null-semantics/locked-corpus PASS. Typecheck souběžně hlásil pouze `src/scene/visibility.ts:28` possibly undefined; hlavní agent dokončuje tuto samostatnou renderer změnu. Tento harness nemění compiler/render/runtime.

Příkaz nového běhu (adresář nesmí existovat):

```powershell
$env:P20_T18_RUN_DIR='plans/P20/t18-hybrid-NEW'
npx vitest run --config vitest.measure.mts evals/worldstream/world-quality/integrated.measure.ts
```

Po doběhu: z completed30 a zachovaných failures sestavit strojový souhrn; přes existující produkční galerii zachytit všechny certifikované blueprinty se všemi30 původními řádky. Teprve skutečné browserové a nezávislé lidské důkazy mohou doplnit odpovídající brány.
