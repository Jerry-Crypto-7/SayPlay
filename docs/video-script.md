# Scénář aktuálního živého A4 videa — 1:30

Finální místní [worldstream-a4-live.mp4](../videos/worldstream-a4/worldstream-a4-live.mp4): skutečný souvislý browser záznam v3 a jeho skutečný závěrečný snímek. Žádná publikace, fixture substituce ani lidská studie. [Storyboard, asset provenance a encoded QA](../videos/worldstream-a4/README.md).

| Čas videa | Zdroj a obsah |
|---|---|
| 0:00–0:06 | Úvod „Přetoč a přepiš“ a přesné vlastní zadání čítárny s akváriem, dvěma sedícími lidmi a terminálem ovládajícím signál. |
| 0:06–0:58 | Celých prvních 260 s browser záznamu, přiznaně zrychlených 5×. Skutečný čas od odeslání k ovládání byl 258,445 s. |
| 0:58–1:09,84 | Posledních 11,84 s stejného záznamu 1×: skutečná akce, návrat, modelový návrh a potvrzení. |
| 1:09,84–1:30 | Skutečný hires snímek dvou synchronních budoucností. Vlevo signál svítí, vpravo zůstává zhasnutý. |

Obě větve této ukázky jsou `won`. Změnil se jediný list akce `signalOn:true → false`, nikoli tvrzený výsledek won/running. Commit vrací `comparison-only` bez nového winning certificate. Naměřených 8,555 s následné A4 cesty není délka posledního úseku záznamu ani samostatná latence replay.

Výstup má 1920 × 1080, 30 fps, 2700 snímků, 90 s a žádný zvuk. Původní browser video 800 × 450/25 fps je zvětšené; drobné UI písmo má omezenou čitelnost. Závěrečný samostatný screenshot je nativní 1920 × 1080. Sedm zakódovaných snímků bylo skutečně prohlédnuto.

Toto jediné živé pozorování nesplňuje cíl latence a nedokládá obecnou kvalitu, nezávislé lidské hodnocení nebo veřejný provoz. Video už lokálně existuje; veřejné odevzdání nebylo provedeno. Historický draft `worldstream-a4-local.mp4` zůstává označeným odděleným artefaktem.

---

<details>
<summary>Historický 2:44 scénář — pouze archiv, nepoužívat pro aktuální produkt</summary>

Následující časová osa, povinné beaty starého checkeru, offline fallback a panel-only rewind jsou superseded. Nepředstavují aktuální video ani dnešní funkce hlavní cesty. Historická čísla jsou zachována beze změny.

# Scénář dema — 2:44 ze 3:00

**P20 lokální pracovní video, 17. 9. 2026:** [90sekundový MP4](../videos/worldstream-a4/worldstream-a4-local.mp4) a [původ, ověření a limity](../videos/worldstream-a4/README.md). Obsahuje označený archiv živé čítárny a oddělené A4/dveřní fixtures. Není finální veřejnou přejímkou ani souvislým záznamem celé živé cesty. Následující scénář je historický.

> **Historický scénář, nepoužívat pro nové P20 video.** P20 A4 má ukázat vlastní generaci → akci → návrat před akci → náhled nečasovačové změny → potvrzení → dvě synchronní budoucnosti s viditelným rozdílem. Níže uvedený offline beat a panel-only rewind popisují starou variantu. Finální video čeká na přijatou generaci a provoz; finální publikované video zatím není hotové. Případné zkrácení čekání musí být označené a skutečný čas uvedený.

Tvrdý limit je **3:00** (`RULES.md` §2). Tenhle scénář má **2:44**, takže na střih
zbývá šestnáct sekund. Stopáž hlídá `node scripts/video-check.mjs docs/video-script.md`
— sečte úseky, ověří, že na sebe navazují, a odmítne scénář, kterému chybí beat.

**Bez obličeje a bez rozpoznatelného hlasu** (`RULES.md` §5). Proto **titulky, žádná
narace**. Titulky jsou anglicky, protože je čte porotce; tenhle dokument je česky,
protože ho čte ten, kdo točí.

---

## Časová osa

| Čas | Beat | Co je na obrazovce | Titulek |
|---|---|---|---|
| 0:00–0:12 | `opening` | Prázdné plátno, uprostřed nápověda „Napiš větu. Postaví se z ní svět, který se dá hrát.", nahoře pole. Kurzor píše větu, kterou systém nikdy neviděl. | `A sentence goes in. Not a prompt for a model — an input to a compiler.` |
| 0:12–0:40 | `world-builds` | Tlačítko „Postav svět" → „Pracuju…", stavy „odesláno / generuje se / staví se". Svět se odkrývá po kusech. Pak najetí na panel vlevo dole „Co model napsal" — sekce „Tvar stavby", „Pravidla", „Cíl". | `The model writes no code. It emits two declarative branches: a geometry program and a rule graph. Both are on screen, readable.` |
| 0:40–1:00 | `playable` | Hra: číslicemi chůze k cílům, mezerníkem sběr. Postava se hýbe, počítadlo cíle se mění. | `Hand-written deterministic interpreter runs it. Twenty ticks a second, no wall clock anywhere in the hashed state.` |
| 1:00–1:32 | `winning-path` | Panel vpravo dole „Jak to systém vyhrál". Postupuje počítadlo „3 / 5 · výhra v tiku 240", řádky kroků typu „2. tik 60 — player: pickup → key1". Na konci tlačítko „Přehrát znovu". | `Nobody scripted this route. The verifier searched for it, certified it, and the replay's hash equals the certificate's.` |
| 1:32–2:10 | `rule-rewind` | Panel vlevo dole „Čas". Táhlo „Přetočit čas" jede zpět, počítadlo „tik N / 200" klesá. Klik na „Vypnout jedno pravidlo a přepočítat budoucnost". Objeví se věta „Bez pravidla … Budoucnost se přepočítala." a druhý hash „· původní …". | `Rewind, switch one rule off, and the future is recomputed from that tick. Two state hashes, side by side: the old one and the one that exists now.` |
| 2:10–2:34 | `offline` | Otevřený Network panel v prohlížeči, v něm se přepne **Offline**. Druhá neviděná věta. Požadavek na `/api/generate` je červený a **nedoletí** — a svět se přesto postaví. Nad polem se objeví „Server je nedostupný, takže tenhle svět postavil prohlížeč sám." V seznamu požadavků není jediný bajt modelových vah. | `The network is off. Nothing left to ask. The world is built here, in the browser — no weights downloaded, no model call, nothing to be offline from.` |
| 2:34–2:44 | `close` | Veřejná adresa dema na plátně, pod ní postavený svět z posledního beatu. | `Type your own sentence.` |

**Součet 2:44.** Sedm úseků, čtyři povinné beaty (`world-builds`, `rule-rewind`,
`offline`, `winning-path`) plus tři přechodové.

---

## Věty, které se do kamery píšou

Obě jsou **mimo** ukázky, které nabízí prázdná obrazovka, a mimo text v poli. To je
schválně: `RULES.md` §3.3 říká, že porotce zkouší vlastní prompty, takže demo, které
předvádí své vlastní ukázky, nedokazuje nic.

1. Beat `world-builds`: `a stealth level where guards patrol and see me if I stand in the light`
2. Beat `offline`: libovolná věta, kterou píšeš až u kamery — čím míň připravená, tím
   líp. Nemusí být rozpoznaná; když nebude, postaví se náhradní místnost a nad polem
   se objeví věta, která to přizná. **To je taky dobrý záběr**, ne vada — jen se u něj
   titulek změní na `Even a sentence it cannot read yields a playable room, and says so.`
   **Offline se v DevTools zapíná až po načtení stránky**, ne před ním: záruka je o
   větě, ne o prvním načtení, a service worker tu žádný není.

---

## Co se netočí, a proč

- **U beatu `rule-rewind` drž záběr na panelu, ne na 3D scéně.** Panel času si počítá
  vlastní simulaci vedle plátna, takže se po přepočtu **nepřeanimuje svět** — změní se
  počítadlo tiku, přibude druhý hash a napíše se výsledková věta. Záběr na plátno by
  ukazoval, že se nestalo nic.
- **Nezmiňuj rychlost lokálního modelu.** Naměřený medián je desítky sekund a
  `schemaValid` 0 ze 40; model proto v produktu není zapojený a číslo by mluvilo o
  větvi, kterou nikdo nevidí.
- **Žádný firemní branding, paleta ani font zaměstnavatele** (`RULES.md` §5).

---

## Čísla, která se smí objevit v titulku

Každé je naměřené v repozitáři, ne odhad.

| Číslo | Kde je naměřené |
|---|---|
| pole je použitelné do 3 s od načtení | `e2e/first-click.spec.ts` — běh vypíše skutečnou hodnotu |
| svět se skládá 800 ms (16 tiků při 20 Hz) | `src/components/viewer/Assembly.tsx` |
| 70 nepřátelských vět → 70 hratelných světů, 0 prázdných scén | `evals/hostile-report.json` |
| nejpomalejší z těch 70 vět: 19,76 ms | `evals/hostile-report.json` |
| horizont přetáčení 200 tiků | `src/components/pipeline/Timeline.tsx` |

**Nepoužívej „svět se postaví do dvou sekund".** Je to cíl ze specifikace, ne číslo
naměřené od věty k hotovému snímku. Obhajitelné znění je to v tabulce výš.

</details>
