# Worldsmith original starter assets

These six models were authored for this project on 2026-09-17 using the
Codex-assisted source `scripts/assets/originals.mjs`. No external model,
photograph, texture, or third-party asset was imported. Three.js creates and
exports the geometry; its software license is recorded separately in disclosure.

License identifier: **LicenseRef-Worldsmith-Original**. These are first-party
project assets, supplied under the project's terms; this record does not claim
a third-party license or grant additional rights on the project owner's behalf.
No third-party asset attribution is required.

Run `node scripts/assets/normalize.mjs` to reproduce the binary assets, previews
and catalog. Run it with `--check` to verify hashes, sizes, geometry accounting
and Khronos glTF validation without rewriting files. The catalog records the
SHA-256 of the original source and every exported GLB. Both LODs use meters,
+Y up and +Z front. Origin is the floor/support plane. The door leaf is a named
child group whose local origin is the left hinge. The seated figure's seat socket
is at 0.46 m above its floor plane.

Materials are untextured metallic/roughness PBR, with core alpha blending for
glass and water. Aquarium transparency is a lightweight approximation, not
physical transmission. Collider boxes are conservative interaction bounds.
Thumbnails are deterministic rasterizations of the actual original geometry.
