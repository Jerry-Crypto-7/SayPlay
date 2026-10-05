# PLAY catalog batch – format

A catalog batch is one JSON file listing 3D models that the local model pipeline (`ops/gen3d`) produced
and checked, before they are promoted into the PLAY catalog. Code: `src/play/assets/batch.ts`
(`catalogBatchSchema`, `readBatch(path)`). Examples: `src/play/assets/__fixtures__/batch-*.json`.

```json
{ "schema": "catalog-batch.v1", "entries": [{ "id", "nouns", "glb", "lod1", "bounds", "palette", "source", "licence", "checked" }] }
```

Unknown keys are refused, at every level. Entry ids are unique within a batch.

## Entry fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Model id: lower case letters, digits and `-`, starting with a letter (`alien-bug`). |
| `nouns` | yes | Words a sentence uses to name the model, lower case, singular; a phrase such as `alien bug` is allowed. At least one. |
| `glb` | yes | Path of the full-detail model file (`.glb`) as the pipeline wrote it. |
| `lod1` | no | Path of the lighter level-of-detail model (`.glb`). |
| `bounds` | yes | Size in GLB units `[x, y, z]` in the rest pose, all positive – the same measure as `dims` in the hero manifest. |
| `palette` | yes | The model's colours after stylisation, `#rrggbb` lower case, 1–16 of them. |
| `source.pipeline` | yes | Which pipeline made it (`ops/gen3d`). |
| `source.imageModel` | yes | The image model that drew the reference picture. |
| `source.shapeModel` | yes | The image-to-3D model that built the mesh. |
| `source.seed` | yes | Whole number ≥ 0; with the two models it reproduces the result. |
| `licence` | yes | SPDX id or `LicenseRef-…` the model ships under. |
| `checked.judge` | yes | Who judged the model without knowing the intended noun. |
| `checked.verdict` | yes | `pass` or `fail`. Only `pass` entries are promoted into the catalog. |

`readBatch` never throws on a bad shape: it returns `{ ok: false, issues }`, each issue a JSON path and a
message (`/entries/0/licence: …`). A missing file or broken JSON does throw.
