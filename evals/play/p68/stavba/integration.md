# P68-S stavba – co potřebuje zapojení (`buildshift`)

Požadavky pruhu P68-S na P68-I. Hra je hotová, až tu bude značka `p68-ready: buildshift`.

## Pitch

_(T8)_

## Sentences

_(T8: 20 vět pro klasifikátor a čtečku)_

## Cues

_(T4/T8)_

## Assets

_(T8: jen z dnešního katalogu; nový asset = požadavek s licencí a zdrojem)_

## Fixture spec

_(T4: `e2e/fixtures/p68-buildshift-spec.json`)_

## Contract needs

Z kontroly kostry `5005bfe3` (T1):

- **Žádná změna kontraktu není potřeba ke hraní.** Vstup `lanes` nese stavbu i provoz (ťuk + osa buňky), pohled `top`
  je povolený, horizont 5400 tiků stačí, `CONTROL_PARAMS.buildshift` bez parametrů vyhovuje (cíl jde přes generátor).
- **Kostra ještě není v `origin/main`.** Pruh stojí na WIP `5005bfe3`; potřebuje sloučenou kostru, aby šel PR jen
  s vlastními soubory (README → Základ větve).

## HUD labels

_(T5/T10: „Served“ a „Coins“ do `HUD_COUNTER_LABELS`; do té doby čísla ve 3D scéně)_
