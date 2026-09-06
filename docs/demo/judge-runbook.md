# Runbook: co porotce uvidí a kdy

Tenhle soubor popisuje **porotcův průchod z jeho strany** – co je na obrazovce,
v jakém pořadí a jak dlouho na to čeká. Není to popis architektury; co se děje
uvnitř, je ve `WORLDSTREAM-DESIGN-BOOK.md`.

Cestu měří jediná sada, `e2e/judge-flow.spec.ts`, a měří ji **bez jediného
odchycení sítě**. To je celá její cena: sada, která si odpověď podstrčí, je
zelená i tehdy, když je řetěz rozbitý – tedy zelená přesně tehdy, kdy má
křičet.

## ⚠ Odkud jsou ta čísla

Doby níž naměřil ten test **nad skladem dopředu autorovaných světů**, ne nad
modelem. Klíč se podle rozhodnutí z 5. 9. 2026 nekupuje (`G2`), takže první
větu obsluhuje sklad. **Živá placená cesta tyhle časy nemá** a až klíč přijde,
patří se přeměřit.

Čísla jsou sem opsaná ručně i s datem běhu, schválně: `evals/` už tři
samopřepisující se soubory má a každý běh sady je posune, aniž se hne jediný
závěr. Ruční opis znamená, že se číslo pohne jedině tehdy, když ho někdo
vědomě přepíše.

Stroj běhu: Windows, headless Chromium přes SwiftShader (softwarový WebGL2,
bez GPU). **Na stroji s grafikou to bude rychlejší, ne pomalejší** – porotcův
notebook je horní odhad, ne dolní.

## Takty průchodu

### Takt 0 – porotce dorazí

Načte se stránka a je na ní **celoobrazovkové plátno a jedno pole na větu**.
Žádná úvodní obrazovka, žádný loading, a hlavně **žádný svět**: dokud porotce
nic nenapsal, stavová věta říká prázdno a scéna je prázdná. Je to záměr –
místnost ukázaná naslepo by byla svět, který nepopsal.

Co dělat: napsat větu. Pole je označené `Describe a place` a příklad v něm je
placeholder, ne předvyplněná odpověď.

### Takt I – věta postaví prostor

Po odeslání se stavová věta přepne na živý svět a na plátně se objeví prostor,
který ta věta popisuje. Porotce nečeká na nic dalšího – **logika běží dřív, než
dorazí detail**, takže scéna je vidět, i když se hmota ještě dopočítává.

Vlajková věta, kterou sklad zná přesně:

> A brutalist observatory, one dome on three splayed legs, on a windswept plateau.

**Tuhle větu vybral sklad, ne vkus.** Průchod má od 6. 9. 2026 i dějství III
(takty IV a V), a to se nedá předvést nad libovolným světem: uvařená druhá věta
musí mířit na objekt kreslený **hrdinským tvarem**, jinak se přepis tvaru
odmítne. Katedrála z kontejnerů, která tu stála dřív, má jedinou uvařenou změnu
a ta je pouze o barvě.

### Takt II – hmota ztvrdne a dá se do ní kouknout

Objekty se přepočítají z hrubého náznaku do tvaru. Porotce si může otevřít
zásuvku **Inspect** vpravo dole a uvidí seznam objektů světa; u každého stojí,
na jaké je příčce – tedy jestli kouká na vymešovaný tvar, na kompozici, nebo
zatím na hlínu.

**Tenhle takt drží meshovač.** Kdyby se odpojil, svět zůstane celý hlínou –
něco se postaví, ale nic neztvrdne. Sada to soudí příčkami, ne počtem objektů,
právě proto.

### Takt III – produkt u známé věty mlčí

Nad vlajkovou větou **žádná poznámka o původu nestojí, a to je správně**. Věta
trefila uvařený svět přesně, takže se nic nenahrazovalo a není co přiznávat.
Poznámka patří k **náhradě** – porotce ji uvidí u taktů IV a VI. Kdyby stála
u každého světa, byla by z poctivosti omluva na pozadí, kterou přestane číst.

Že se produkt ozve tam, kde má, a mlčí tam, kde nemá, měří sada v jednom
průchodu obojí – „někdy mlčí, někdy mluví" je tvrzení, které se jinak splnit
nedá.

### Takt IV – druhá věta chirurgicky změní jeden objekt

Pod plátnem je druhé pole, **Change one thing in this world**. Porotce do něj
napíše, co má být jinak, a produkt mu nejdřív ukáže **plán, ne hotovou změnu**:
který objekt se změní, jednou větou co se s ním stane, čeho se změna týká
(tvar / chování / vzhled) a jmenovitě **co zůstane**. Nic se nestane, dokud
porotce nezmáčkne *Apply*.

Sada na to používá:

> Splay the observatory legs wider so the dome drops lower.

Je to schválně **jinými slovy**, než jak tu větu zná sklad („Splay the
observatory legs further out so the dome sits lower."), protože porotce píše
vlastní větu, ne opsanou. Produkt proto vedle plánu řekne nahlas, že ten plán
napsal dopředu sklad, ne model teď.

### Takt V – potvrzení a svět se změní pod rukama

Po *Apply* se svět přestaví a panel plánu zmizí. **Žádný objekt nepřibude ani
nezmizí** a svět se nezakládá znovu – porotce má po změně tentýž svět, ne nový.
To je celý rozdíl mezi „chirurgickou změnou" a „novým světem".

⚠ **„Jeden objekt" znamená jeden CÍL, ne jednu dotčenou věc, a je poctivé to
říct nahlas.** Vlajková věta jmenuje nohy i kupoli, takže uvařená změna posune
kupoli a zároveň přepíše parametr rozkročení nohou. Cíl je jeden – kupole –
a panel proto pod plánem jmenuje jenom to, čeho se změna doopravdy nedotýká
(u téhle věty plošinu, nikoli nohy). **Ten seznam se počítá z operací té
změny**, ne z toho, koho věta jmenovala jako cíl; do 6. 9. 2026 se počítal
opačně a produkt si tím uvnitř jednoho průchodu odporoval.

⚠ **Ten řádek se od 6. 9. 2026 jmenuje „Not named by this change", ne
„Untouched", a ten rozdíl není kosmetický.** Sdílený poddokument – paleta,
světelný rig, mřížka socketů – umí objekt řídit, aniž ho jmenuje, a úplné
přiřazení „která cesta patří kterému objektu" v dokumentu prostě není
(naměřeno: dva ze šesti socketů observatoře si nenárokuje žádná entita).
Produkt proto tvrdí **přesně to, co umí spočítat**: že žádná operace té změny
tyhle objekty nejmenuje. Slibovat „nedotčeno" by bylo o slovo víc, než se dá
doložit.

⚠ **Změna nemusí být nápadná a je to vlastnost, ne vada.** Kupole se posune;
počet trojúhelníků se tím nehne vůbec, hne se umístění. Kdo hledá „vidím
rozdíl", ať se dívá na kupoli, ne na siluetu.

### Takt VI – porotce zkusí vlastní větu

`RULES.md` §3.3 mu na to dává právo, takže je to ten takt, o který se demo
doopravdy rozbije. Věta, kterou nikdo nepředvídal, **nesmí skončit prázdnem ani
chybou** – odpoví jí nejbližší autorovaný svět. Sada na to používá:

> A lighthouse built from stacked fishing boats, still dripping.

A **teď** se produkt ozve: tenhle svět nenapsal model ani nikdo nepsal na tuhle
větu, je to nejbližší uvařený. Porotce má právo to vědět a přihláška se soudí
i podle toho, co o sobě produkt tvrdí.

## Naměřené doby taktů

Běh 6. 9. 2026, `npx playwright test e2e/judge-flow.spec.ts --project=chromium`,
celá sada **78 s**. Druhý sloupec je předchozí běh téhož dne – je tam schválně,
aby bylo vidět, **jak moc se ta čísla hýbou sama od sebe**.

| Takt | Co porotce dělá | Naměřeno | Předchozí běh |
|---|---|---|---|
| 0 | stránka se načte a čeká na větu | **516 ms** | 572 ms |
| I | věta → svět na plátně (první vykreslený snímek) | **1 878 ms** | 1 272 ms |
| II | hmota ztvrdne a je vidět v Inspect | **1 165 ms** | 646 ms |
| IV | druhá věta → plán změny | **965 ms** | 737 ms |
| V | potvrzení → změněný svět | **887 ms** | 1 357 ms |
| VI | vlastní věta porotce → svět | **4 043 ms** | 3 615 ms |

**Rozptyl mezi dvěma běhy je skoro dvojnásobek**, takže se z těch čísel dá číst
řád, ne přesná hodnota. Řád je to podstatné: porotce čeká na první svět
**jednotky sekund**, ne desítky. Pro srovnání, lokální model v prohlížeči měl
medián 35–39 s na větu, a to je ten rozdíl, kvůli kterému se od něj upustilo.

**Takt III v tabulce není schválně** – neměří se v něm čekání, ale to, že
produkt u přesně známé věty o původu mlčí. Trvá tolik, co jedno přečtení DOM.

⚠ **Takty I a VI nejsou totéž číslo a nemají být.** Přesně známá věta jde ze
skladu rovnou, neznámá se musí nejdřív porovnat se všemi uvařenými světy –
proto je takt VI zhruba dvojnásobek taktu I. Obojí je pod pěti sekundami.

Součet taktů 0, I a II je **zhruba 3,6 s od načtení stránky k hotové hmotě**.

## ⚠ Co porotce na téhle cestě NEDOSTANE

Design book §4 slibuje **čtyři dějství**. Cesta na hlavní stránce má od
6. 9. 2026 **první tři**; dějství III se na ni dostalo tím, že plánovač změny
dostal tutéž záložní cestu přes sklad autorovaných světů, jakou měla první
věta. Ověřeno ve zdroji a naměřeno sadou, ne odhadnuto.

Chybí **přetáčení času a větvení budoucnosti** (dějství IV). Osa se do skořápky
předává propem `axis` a hlavní stránka ho nepředává, takže žije jen na
vývojářské adrese `/dev/time`. Postavené a otestované to je – jen ne na
porotcově cestě. Až se na ni dostane, patří do `e2e/judge-flow.spec.ts` takt
navíc, ne nová sada.

**Do té doby se ani v přihlášce, ani ve videu nesmí tvrdit, že porotce projde
přetáčení času sám.** Ukázat se dá na vývojářské adrese; tvrdit se o něm smí
jen to, co platí.

⚠ **Druhá věta má dnes výrobce jen pro pět světů z jedenácti** (`c01`, `c03`,
`c04`, `c09`, `c20`), a i tam vždycky jen pro jeden objekt. Porotce, který
zkusí změnit cokoli jiného, dostane odmítnutí – a to odmítnutí musí říkat
pravdu. **Říká ji od 6. 9. 2026:** do té doby vracelo `MODEL_UNAVAILABLE`
a větu „the model could not be reached", což je popis výpadku, který se nestal
(žádný model se nevolá, klíč se podle `G2` nekupuje). Dnes vrací
`NO_AUTHORED_CHANGE` a větu *„no change for that object was authored ahead of
time, and no model is configured to write one now."*

Vlajková věta je proto vybraná z té pětky. **Takt VI je opačný případ a je to
tak schválně:** vlastní věta porotce dostane nejbližší uvařený svět, ale druhá
věta nad ním už uvařenou změnu mít nemusí – tam porotce uvidí právě to
odmítnutí.

## Čím se ta sada dá zfalšovat, a co se stane

Break-it-on-purpose, 6. 9. 2026: meshovač se odpojil (worker se nikdy
nepostaví) a sada musela zčervenat **na taktu II**, ne až na konci. Zčervenala.

Stálo to jednu opravu vlastní aserce, a je to poučení, ne poznámka. První
podoba se ptala „zůstal aspoň jeden objekt něčím jiným než hlínou?" a to platí
**i s odpojeným meshovačem**: kompoziční objekty meshovač nepotřebují. Naměřeno
– s meshovačem `g2-rich, g3-reduced, g2-rich`, bez něj `g2-rich, semantic-clay,
g2-rich`. Do hlíny spadne **právě hrdinský tvar**, takže se sada musí ptát na
příčku `g3-reduced` jménem. Slabší otázka by tenhle výpadek propustila.
