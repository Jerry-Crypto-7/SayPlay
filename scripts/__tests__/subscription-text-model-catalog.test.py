"""Offline source pin and exact field-preservation tests; no CLI/runtime."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

PATH = Path(__file__).resolve().parents[1] / 'subscription-text-model-catalog.py'
SPEC = importlib.util.spec_from_file_location('text_catalog', PATH)
catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog)


def fixture_source(models=None):
    return {'models': models if models is not None else [{'slug': catalog.MODEL, 'tool_mode': 'code_mode_only',
            'multi_agent_version': 'v2', 'unknownPreserved': {'nested': [True, None, 'žluťoučký', 42]}}], 'rootMetadata': {'keep': True}}


def encode(value):
    return json.dumps(value, ensure_ascii=False).encode('utf-8')


def test_actual_pinned_source_preserves_every_value_except_two_named_fields():
    raw = catalog.SOURCE.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == catalog.SOURCE_SHA256
    original = json.loads(raw)
    selected = [model for model in original['models'] if model['slug'] == catalog.MODEL]
    assert len(selected) == 1
    expected = copy.deepcopy(original)
    expected['models'] = copy.deepcopy(selected)
    expected['models'][0].update(tool_mode='direct', multi_agent_version='disabled')
    result = catalog.derive_catalog(raw)
    assert json.loads(result) == expected
    assert result == catalog.derive_catalog(raw)
    assert result.endswith(b'\n')
    assert catalog.OUTPUT.read_bytes() == result
    changed = {key for key in selected[0] if selected[0][key] != expected['models'][0][key]}
    assert changed == {'tool_mode', 'multi_agent_version'}
    assert selected[0]['tool_mode'] == 'code_mode_only'
    assert selected[0]['multi_agent_version'] == 'v2'


def test_drift_is_rejected_before_json_parsing():
    for raw in [catalog.SOURCE.read_bytes() + b' ', b'not-json', b'{}']:
        with pytest.raises(catalog.CatalogError, match='SOURCE_HASH_MISMATCH'):
            catalog.derive_catalog(raw)


@pytest.mark.parametrize('raw,code', [
    (b'{"models":[],"models":[]}', 'DUPLICATE_JSON_KEY'),
    (b'{"models":[{"slug":"x","slug":"y"}]}', 'DUPLICATE_JSON_KEY'),
    (b'{"models":[],"value":NaN}', 'NONFINITE_JSON'),
    (b'[]', 'INVALID_MODELS_RESPONSE'),
    (b'{"models":[]}', 'MISSING_FIXED_MODEL'),
    (b'{"models":[{"slug":"x"},{"slug":"x"}]}', 'DUPLICATE_MODEL_SLUG'),
    (b'{"models":[{"slug":null}]}', 'INVALID_MODEL_ENTRY'),
    (b'{"models":[{"slug":"gpt-5.6-sol","tool_mode":"direct","multi_agent_version":"v2"}]}', 'SOURCE_TOOL_PROFILE_MISMATCH'),
])
def test_secondary_structural_guards_with_test_only_pin(monkeypatch, raw, code):
    # Production has no caller override. Pin substitution is solely to exercise
    # guards otherwise unreachable behind the immutable public-source digest.
    monkeypatch.setattr(catalog, 'SOURCE_SHA256', hashlib.sha256(raw).hexdigest())
    with pytest.raises(catalog.CatalogError, match=code):
        catalog.derive_catalog(raw)


def test_unknown_root_and_nested_values_are_retained(monkeypatch):
    value = fixture_source()
    value['models'].append({'slug': 'other', 'tool_mode': None, 'multi_agent_version': None})
    raw = encode(value)
    monkeypatch.setattr(catalog, 'SOURCE_SHA256', hashlib.sha256(raw).hexdigest())
    actual = json.loads(catalog.derive_catalog(raw))
    expected = copy.deepcopy(value)
    expected['models'] = expected['models'][:1]
    expected['models'][0].update(tool_mode='direct', multi_agent_version='disabled')
    assert actual == expected
    assert value['models'][0]['tool_mode'] == 'code_mode_only'


def test_only_fixed_cli_arguments_and_no_overwrite(monkeypatch, tmp_path):
    source = tmp_path / 'source.json'; source.write_bytes(catalog.SOURCE.read_bytes())
    output = tmp_path / 'catalog.json'
    monkeypatch.setattr(catalog, 'SOURCE', source)
    monkeypatch.setattr(catalog, 'OUTPUT', output)
    with pytest.raises(catalog.CatalogError, match='FIXED_CATALOG_ARGUMENTS_ONLY'):
        catalog.main(['--model', 'other'])
    with pytest.raises(catalog.CatalogError, match='ARTIFACT_MISSING'):
        catalog.main(['--check'])
    assert catalog.main([]) == 0
    assert catalog.main(['--check']) == 0
    output.write_bytes(b'user changes')
    with pytest.raises(catalog.CatalogError, match='EXISTING_ARTIFACT_MISMATCH'):
        catalog.main([])
    assert output.read_bytes() == b'user changes'


def test_invalid_source_type_and_limit():
    for value in ['', bytearray(b'{}'), b'x' * (catalog.MAX_SOURCE_BYTES + 1)]:
        with pytest.raises(catalog.CatalogError, match='INVALID_SOURCE_BYTES'):
            catalog.derive_catalog(value)
