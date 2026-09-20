# Nálezy proti sdíleným kontraktům PLAY

Append-only. Každá vrstva (P23-A kompilátor, P23-B režisér, P23-C obálka) sem
zapíše, co jí v `src/play/contracts.ts` chybí nebo neodpovídá, místo aby
kontrakt měnila sama. Změnu kontraktu dělá až společný krok nad všemi třemi.

## P23-B

- **`DirectorResult` větev `ok:false` nemá kdy nastat.** `direct()` (`src/play/director/index.ts`)
  má vždy návrh ze slov (`draftGameSpec` nikdy nevrátí `null`), takže výpadek modelu, nečitelná
  odpověď i neopravitelný spec končí `ok:true, source:'draft'` a důvod jde do `fallbackReason`
  (`MODEL_UNAVAILABLE` | `MALFORMED` | `UNREPAIRED`). `DirectedGame` je **rozšíření**
  `Extract<DirectorResult, {ok:true}>` o `fallbackReason`, `warnings`, `ms`, `calls` –
  přiřaditelné do kontraktu beze změny. Návrh: při společném kroku větev `ok:false` z
  `DirectorResult` vypustit a `fallbackReason` do kontraktu přidat.
- **Klíč cache** bere `endpoint` z `GenerationBranch.id` a `model` z `UpstreamRequest.model`
  (= `EMISSION_MODEL`), protože `direct()` dostává větev, ne konfiguraci. Kdyby obálka měla dva
  koncové body s týmž `id`, potřebuje kontrakt `branch.id` odlišit – zatím není důvod.
