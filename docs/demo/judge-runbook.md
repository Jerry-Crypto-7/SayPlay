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

> A cathedral of stacked shipping containers around a light well.

### Takt II – hmota ztvrdne a dá se do ní kouknout

Objekty se přepočítají z hrubého náznaku do tvaru. Porotce si může otevřít
zásuvku **Inspect** vpravo dole a uvidí seznam objektů světa; u každého stojí,
na jaké je příčce – tedy jestli kouká na vymešovaný tvar, na kompozici, nebo
zatím na hlínu.

**Tenhle takt drží meshovač.** Kdyby se odpojil, svět zůstane celý hlínou –
něco se postaví, ale nic neztvrdne. Sada to soudí příčkami, ne počtem objektů,
právě proto.

### Takt III – produkt řekne, odkud ten svět je

Vedle stavové věty stojí poznámka, že svět **nenapsal model, ale sklad dopředu
autorovaných světů**. Není to omluva ani drobné písmo: porotce má právo vědět,
co zrovna vidí, a přihláška se soudí i podle toho, co o sobě tvrdí.

### Takt IV – porotce zkusí vlastní větu

`RULES.md` §3.3 mu na to dává právo, takže je to ten takt, o který se demo
doopravdy rozbije. Věta, kterou nikdo nepředvídal, **nesmí skončit prázdnem ani
chybou** – odpoví jí nejbližší autorovaný svět. Sada na to používá:

> A lighthouse built from stacked fishing boats, still dripping.

## Naměřené doby taktů

Běh 6. 9. 2026, `npx playwright test e2e/judge-flow.spec.ts --project=chromium`,
celá sada **50 s**. Druhý sloupec je předchozí běh téhož dne – je tam schválně,
aby bylo vidět, **jak moc se ta čísla hýbou sama od sebe**.

| Takt | Co porotce dělá | Naměřeno | Předchozí běh |
|---|---|---|---|
| 0 | stránka se načte a čeká na větu | **406 ms** | 389 ms |
| I | věta → svět na plátně (první vykreslený snímek) | **1 854 ms** | 1 006 ms |
| II | hmota ztvrdne a je vidět v Inspect | **1 170 ms** | 691 ms |
| IV | vlastní věta porotce → svět | **2 998 ms** | – |

**Rozptyl mezi dvěma běhy je skoro dvojnásobek**, takže se z těch čísel dá číst
řád, ne přesná hodnota. Řád je to podstatné: porotce čeká na první svět
**jednotky sekund**, ne desítky. Pro srovnání, lokální model v prohlížeči měl
medián 35–39 s na větu, a to je ten rozdíl, kvůli kterému se od něj upustilo.

**Takt III v tabulce není schválně** – neměří se v něm čekání, ale to, že
produkt u přesně známé věty o původu mlčí. Trvá tolik, co jedno přečtení DOM.

Součet taktů 0, I a II je **zhruba 3,4 s od načtení stránky k hotové hmotě**.

## ⚠ Co porotce na téhle cestě NEDOSTANE

Design book §4 slibuje **čtyři dějství**. Cesta na hlavní stránce má dnes
první dvě. Ověřeno 6. 9. 2026 ve zdroji, ne odhadnuto:

- **Druhá věta, která chirurgicky změní jeden objekt** (dějství III), na hlavní
  stránce není. Panel změny se do skořápky předává propem `change` a hlavní
  stránka ho nepředává; žije na `/dev/refine`. Navíc plánovač změny se staví
  výhradně z cloudového modelu a **nemá záložní cestu přes sklad autorovaných
  světů**, kterou první věta od `T46-routewire` má. Bez zaplaceného klíče
  (`G2`, rozhodnuto 5. 9. 2026) tedy druhá věta nemá výrobce vůbec.
- **Přetáčení času a větvení budoucnosti** (dějství IV) na hlavní stránce taky
  není – osa se předává propem `axis` a hlavní stránka ho nepředává. Žije na
  `/dev/time`.

Obojí je **postavené a otestované**, jen na vývojářských adresách, které nejsou
součástí porotcovy cesty. Až se na hlavní stránku dostanou, patří do
`e2e/judge-flow.spec.ts` dva takty navíc – ne nová sada, jinak se „celý
průchod" zase rozpadne na kusy, které nikdo nezkouší najednou.

**Do té doby se ani v přihlášce, ani ve videu nesmí tvrdit, že porotce ta dvě
dějství projde sám.** Ukázat se dají na vývojářských adresách; tvrdit se o nich
smí jen to, co platí.

## Čím se ta sada dá zfalšovat, a co se stane

Break-it-on-purpose, 6. 9. 2026: meshovač se odpojil (worker se nikdy
nepostaví) a sada musela zčervenat **na taktu II**, ne až na konci. Zčervenala.

Stálo to jednu opravu vlastní aserce, a je to poučení, ne poznámka. První
podoba se ptala „zůstal aspoň jeden objekt něčím jiným než hlínou?" a to platí
**i s odpojeným meshovačem**: kompoziční objekty meshovač nepotřebují. Naměřeno
– s meshovačem `g2-rich, g3-reduced, g2-rich`, bez něj `g2-rich, semantic-clay,
g2-rich`. Do hlíny spadne **právě hrdinský tvar**, takže se sada musí ptát na
příčku `g3-reduced` jménem. Slabší otázka by tenhle výpadek propustila.
