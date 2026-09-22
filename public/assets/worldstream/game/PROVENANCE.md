# Worldsmith original game models

These models were authored for this project from 2026-09-22 in Blender 5.1,
AI-assisted, by the source `scripts/assets/blender/game_models.py`. Every
shape is assembled in code from primitive solids (boxes, cylinders, spheres,
tori). No external model, photograph, texture, generative 3D model or
third-party asset was used. Blender is the authoring tool only; its GPL license
does not apply to the models it exports.

License identifier: **LicenseRef-Worldsmith-Original**. These are first-party
project assets, supplied under the project's terms; this record does not claim
a third-party license or grant additional rights on the project owner's behalf.
No third-party asset attribution is required.

Run `node scripts/assets/game-models.mjs` to rebuild the models, previews and
catalog records (requires Blender 5.1). Run it with `--check` to verify hashes,
sizes, triangle counts and Khronos glTF validation without Blender. A rebuild
reproduces the same structure, sizes and triangle counts; the binary buffer may
differ in the last bits of a few floats, so it is not a byte-exact reproduction. Both LODs
use meters, +Y up and +Z front; the origin is the centre of the floor plane.
Materials are untextured metallic/roughness PBR, some with emission.
Thumbnails are Blender renders of the actual exported geometry.
