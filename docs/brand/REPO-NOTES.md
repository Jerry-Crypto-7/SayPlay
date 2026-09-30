# Sayplay kit v tomhle repu – odchylky a zapojení

Kit v `docs/brand/` je zdroj pravdy pro vzhled, texty a pohyb celého produktu (`/play`). Kde se tenhle soubor s kitem rozchází, platí tenhle soubor.

## Odchylky od kitu

| Kit říká | V repu platí | Proč |
|---|---|---|
| Bricolage Grotesque 800 (nadpisy) | **Roboto v2.138 Black 900**, tracking podle tabulky v `04-typography.md` | Kit má písma pod SIL OFL; licenční pravidla projektu (`RULES.md` §4) povolují jen MIT, Apache-2.0, BSD, ISC, CC0, Unlicense, CC-BY-4.0. Roboto do v2.138 je Apache-2.0 (`github.com/googlefonts/roboto`), novější verze jsou OFL. |
| Figtree 500/600/700/800 (text) | **Roboto v2.138** 500 / 500 / 700 / 700 | stejný důvod; Roboto nemá 600 ani 800, bere se nejbližší řez |
| `fonts/` v kitu | do repa nepatří | OFL – soubory písem kitu se necommitují |
| Tab bar Make · Play · My games · Me | jen položky, které produkt umí | účty a profil v produktu nejsou; prázdnou položku nevymýšlet |
| Odkaz `sayplay.[tld]/g/{id}` | dnešní `/play/{id}` | doména není rozhodnutá |

## Jak se kit používá v kódu

- Tokeny: `tokens.json` je zdroj, z něj vznikají CSS proměnné a `colorHex` pro three.js. V kódu produktu **nikdy surový hex**, jen `var(--sp-…)`.
- Třídy komponent se jmenují jako v `components/sayplay.css` (`.sp-btn`, `.sp-prompt`, `.sp-hud-pill` …), ať design a kód mluví stejně.
- Reference vzhledu: `reference-screens/*@2x.png`. Nová obrazovka se fotí vedle nich.
- Copy: `docs/11-voice-copy.md` – slovník (game, idea, Make, Remix, Dare) platí pro každý nový text.
- Žádná fialová, žádné sklo ani rozmazané stíny, žádné ✨, emoji jako ikony ani VERZÁLKY v popiscích.
