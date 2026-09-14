# Fixed text model catalog

`subscription-text-model-catalog.py` derives the adjacent JSON artifact exclusively
from `scratch/session8-codex-0.145.0-models.raw.json`, after verifying raw SHA-256
`497d7653bb22358baa29ebd4a70be55ce990b73a64896848a59179485b37db9d`.
The output is a ModelsResponse with the single exact slug `gpt-5.6-sol`. Every
other value in that model and the root response is preserved. Exactly two model
fields change: `tool_mode` from `code_mode_only` to `direct`, and
`multi_agent_version` from `v2` to `disabled`. Object ordering is deterministically
sorted, UTF8 is emitted directly, and the file ends with one newline.

Run `python -B scripts/subscription-text-model-catalog.py` to create the fixed
artifact, or add `--check` to verify it without creating it. An existing differing
artifact is rejected instead of overwritten. There is no CLI model/path/hash
override, network, authentication, subprocess invocation, or credential access.
Hash drift fails before parsing; duplicate keys/slugs, missing model, malformed
source and unexpected original tool profile fail closed. Tests use an explicitly
test-only monkeypatch of the pin to reach secondary structural guards; production
has no such option.

Output: 39387 bytes, SHA-256
`59d22b4ae6532d4f869d776e56faaf2ae169f36038375597f4f1e581459b8791`.
The fixed process launcher must preload this catalog through
`model_catalog_json` before StaticModelsManager construction and make it a verified
read-only image asset. Thread configuration alone cannot retroactively change an
already constructed manager. This generator does not implement that launcher or
prove registry activation, auth/network readiness, inference, or absence of all
tools. The unconditional planning utility remains a separate bookkeeping tool.

## Attribution and modification notice

Derived from OpenAI Codex's public
[models-manager/models.json](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/models-manager/models.json)
at immutable commit `25af12f7e61572b0bc18ddb1008be543b91519b0` (release
rust-v0.145.0). The two modifications are described above; other model values,
including instructional strings and metadata, remain upstream content.

The pinned repository
[LICENSE](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/LICENSE)
is Apache License 2.0 (January 2004), directly verified by the independent source
reviewer: 10926 raw bytes, SHA-256
`d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc`.
This attribution document accompanies the derived artifact without injecting
extra metadata into its ModelsResponse schema. The complete pinned license is
included at `scripts/vendor/codex-model-catalog.LICENSE`, with the exact hash above.
The existing upstream root NOTICE is also preserved verbatim at
`scripts/vendor/codex-model-catalog.NOTICE`: 242 bytes, SHA-256
`9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915`, from
[pinned NOTICE](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/NOTICE).
It contains the upstream Codex copyright and Ratatui notice; preserving the
complete notice does not imply that this JSON catalog itself contains Ratatui code.
The first sandbox public download failed before writing a file; a narrowly
escalated direct raw download passed the pinned hash check. The generator itself consumes only
the already downloaded public raw file; it performs no download.

Offline test command uses `python -B -m pytest -q --tb=short --import-mode=importlib
-p no:cacheprovider --basetemp <fresh-workspace-scratch-path>
scripts/__tests__/subscription-text-model-catalog.test.py`. The first default
import-mode collection failed because this explicitly requested filename contains
`.test`; the corrected import mode collected all tests. Its default global pytest
temporary directory was inaccessible (12 tests passed, one setup error); a fresh
workspace scratch base also hit Windows sandbox ACL errors during setup/cleanup.
The identical scoped suite was therefore run with a fresh workspace base under
narrow test escalation. These failed attempts were not source or artifact
validation PASS results.
