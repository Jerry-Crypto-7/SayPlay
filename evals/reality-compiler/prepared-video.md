# Připravený průchod source UI — doplňkové video, ne final/live

Zachyceno 9. 9. 2026. Export: `video/prepared-walkthrough.mp4`, manifest: `video/prepared-walkthrough.manifest.json`. **45,32 s, 1440 × 1000, 25 fps, H.264, bez zvuku, 2 113 489 bajtů.** SHA-256 MP4: `7f0d35f23a7c9b12c803eb57245bb42b0cb939bb1795e085103cef85957006da`.

Jde o skutečně vykreslenou produkční source UI cestu se scriptovanou kartou A: vložení podkladu, automatické fixture potvrzení parametrů, přijatý runtime vstup/pohyb, timer 20 → 10 sekund, porovnání stejných vstupů a Why s původním podkladem. Horní overlay trvale přiznává PREPARED / SCRIPTED, nulové modelové calls, automatické potvrzení a virtuální simulační hodiny. `humanObservation:false`, sémantické review unchecked / NOT_RUN. Nikdo nebyl nahrazen falešným lidským záznamem.

**Žádné editorial cuts ani změna rychlosti videa.** Zdrojový WebM i MP4 mají dle ffprobe přesně 45,32 s. Proběhl pouze převod VP8 → H.264 (libx264, medium, CRF 18, yuv420p, faststart). Virtuální clock deterministicky řídí browser timers; samostatné reálné pauzy dovolují číst UI. Tato délka není latence modelu ani živého benchmarku. Geometrie je schematická, evidence scriptovaná s unchecked review; video neprokazuje sémantickou správnost ani prostorový přínos pro lidi.

Runtime renderer: **NVIDIA RTX 3090 / ANGLE Direct3D11**, zjištěno ze skutečného canvas WebGL contextu. Produkční `.next/BUILD_ID` obsahuje doslova `unbuilt`; není vydáván za unikátní build identifikátor. Capture manifest proto ukládá SHA-256 `.next/BUILD_ID`, `.next/server/app/page.js` a klientského reference manifestu.

Capture **1/1 PASS**: `scratch/study-session/232c7cf6-df13-4b23-ba80-caf9e15db11f/`. Obsahuje raw WebM, source response, prepared/validated snapshoty a capture manifest. Vizuálně zkontrolovány skutečné snímky MP4: `contact-sheet.png`, `review-frame.png` (3 s) a `why-frame.png` (40 s). Overlay i citace/unchecked jsou čitelné; poslední pohled je na konkrétní část dlouhého Why panelu, nikoli celý panel najednou.

Předchozí pokusy zůstávají v `scratch/study-session/` a export manifestu: `647bf084…` technicky PASS, vizuálně nahrazen kvůli rAF pozastavenému virtuálním clockem; `5c837c75…` PASS před doplněním Why; `2b050f71…` FAIL testového scénáře (chyběl výběr fired rule před očekáváním vysvětlení). Oprava doplnila skutečný výběr v UI, žádný produktový stav se pro video nepřepisuje.

Reprodukce nad existujícím produkčním buildem, vlastní port 3118:

```powershell
$env:RC_STUDY_SMOKE='1'
$env:RC_STUDY_CARD='A'
$env:RC_STUDY_RECORD_VIDEO='1'
npx vitest run --config vitest.measure.mts evals/reality-compiler/study-session.measure.ts
```

Opt-in záznam odmítne `RC_STUDY_RECORD_VIDEO=1` bez smoke fixture režimu. Všechny API cesty kromě scriptovaného source handleru jsou blokované. Session nevytváří `video/final.mp4`, nepřepisuje skutečné study výsledky a nic nepublikuje. A12 final/live video a veřejné předání zůstávají samostatně otevřené.
