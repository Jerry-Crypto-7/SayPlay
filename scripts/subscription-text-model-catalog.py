"""Deterministically derive a fixed text-only catalog from pinned public source.

No runtime, network, authentication, credential access or caller model/config
selection. This is a two-field override, not an all-tools-off assertion.
"""
import copy
import hashlib
import json
from pathlib import Path
import sys

SOURCE_SHA256 = '497d7653bb22358baa29ebd4a70be55ce990b73a64896848a59179485b37db9d'
SOURCE_COMMIT = '25af12f7e61572b0bc18ddb1008be543b91519b0'
MODEL = 'gpt-5.6-sol'
MAX_SOURCE_BYTES = 2 * 1024 * 1024
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'scratch/session8-codex-0.145.0-models.raw.json'
OUTPUT = ROOT / 'scripts/subscription-text-model-catalog.json'


class CatalogError(ValueError):
    pass


def _pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise CatalogError('DUPLICATE_JSON_KEY')
        value[key] = item
    return value


def _constant(_):
    raise CatalogError('NONFINITE_JSON')


def derive_catalog(raw):
    """Return exact deterministic artifact bytes; verify pin before parsing."""
    if type(raw) is not bytes or len(raw) > MAX_SOURCE_BYTES:
        raise CatalogError('INVALID_SOURCE_BYTES')
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA256:
        raise CatalogError('SOURCE_HASH_MISMATCH')
    try:
        source = json.loads(raw.decode('utf-8'), object_pairs_hook=_pairs, parse_constant=_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise CatalogError('INVALID_SOURCE_JSON') from error
    if type(source) is not dict or type(source.get('models')) is not list:
        raise CatalogError('INVALID_MODELS_RESPONSE')
    slugs = set()
    selected = None
    for entry in source['models']:
        if type(entry) is not dict or type(entry.get('slug')) is not str or not entry['slug']:
            raise CatalogError('INVALID_MODEL_ENTRY')
        if entry['slug'] in slugs:
            raise CatalogError('DUPLICATE_MODEL_SLUG')
        slugs.add(entry['slug'])
        if entry['slug'] == MODEL:
            selected = entry
    if selected is None:
        raise CatalogError('MISSING_FIXED_MODEL')
    if selected.get('tool_mode') != 'code_mode_only' or selected.get('multi_agent_version') != 'v2':
        raise CatalogError('SOURCE_TOOL_PROFILE_MISMATCH')
    result = copy.deepcopy(source)
    model = copy.deepcopy(selected)
    model['tool_mode'] = 'direct'
    model['multi_agent_version'] = 'disabled'
    result['models'] = [model]
    return (json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + '\n').encode('utf-8')


def _regular_file(path):
    if path.is_symlink() or not path.is_file():
        raise CatalogError('REGULAR_FILE_REQUIRED')
    # Windows junction/reparse sources are not accepted as fixed source paths.
    stat = path.lstat()
    if getattr(stat, 'st_file_attributes', 0) & 0x400:
        raise CatalogError('REPARSE_FILE_REJECTED')


def main(arguments=None):
    args = sys.argv[1:] if arguments is None else arguments
    if args not in ([], ['--check']):
        raise CatalogError('FIXED_CATALOG_ARGUMENTS_ONLY')
    _regular_file(SOURCE)
    if SOURCE.stat().st_size > MAX_SOURCE_BYTES:
        raise CatalogError('INVALID_SOURCE_BYTES')
    result = derive_catalog(SOURCE.read_bytes())
    if OUTPUT.exists() or OUTPUT.is_symlink():
        _regular_file(OUTPUT)
        if OUTPUT.read_bytes() != result:
            raise CatalogError('EXISTING_ARTIFACT_MISMATCH')
    elif args == ['--check']:
        raise CatalogError('ARTIFACT_MISSING')
    else:
        # Do not replace an unrelated artifact or follow an existing link.
        with OUTPUT.open('xb') as handle:
            handle.write(result)
    print(json.dumps({'status': 'PASS', 'sourceSha256': SOURCE_SHA256,
                      'outputSha256': hashlib.sha256(result).hexdigest(), 'outputBytes': len(result),
                      'models': [MODEL], 'overrides': {'tool_mode': 'direct', 'multi_agent_version': 'disabled'},
                      'productionReady': False}, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except CatalogError as error:
        print(json.dumps({'status': 'FAIL', 'error': str(error), 'productionReady': False}), file=sys.stderr)
        raise SystemExit(1)
