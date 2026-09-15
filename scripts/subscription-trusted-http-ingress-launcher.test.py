"""Offline fixed composition; original launcher owns all runtime operations."""
import hashlib
import importlib.util
from pathlib import Path
from unittest.mock import Mock, patch
import pytest

spec = importlib.util.spec_from_file_location('http_launcher_tests', Path(__file__).with_name('subscription-trusted-http-ingress-launcher.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


def test_only_fixed_selector_and_source_scope_change():
    runtime = m.load_runtime()
    assert len(runtime.SOURCE_NAMES) == 19 and set(m.HTTP_HELPERS) <= set(runtime.SOURCE_NAMES)
    assert runtime.COMMAND[-1] == '--trusted-http-ingress-fd'
    assert runtime.COMMAND[:5] == ('/usr/bin/timeout', '--signal=TERM', '--kill-after=5', '200', '/usr/bin/unshare')
    assert runtime.FD == 198 and runtime.EMIT_SECONDS == 2
    assert runtime.challenge('BEFORE', 'a' * 32) == b'BEFORE ' + b'a' * 32 + b'\n'
    assert runtime.challenge('AFTER', 'a' * 32) == b'AFTER ' + b'a' * 32 + b'\n'
    assert runtime.run.__code__.co_filename.endswith(m.BASE)


def test_wrong_base_hash_rejected_before_import():
    with patch.object(m.importlib.util, 'module_from_spec') as imported:
        with pytest.raises(ValueError, match='BASE_SOURCE'): m.load_runtime({m.BASE: '0' * 64})
        imported.assert_not_called()


@pytest.mark.parametrize('case', ['arguments', 'platform', 'used'])
def test_guard_before_runtime(case):
    with patch.object(m.sys, 'argv', ['launcher', '--caller'] if case == 'arguments' else ['launcher']), \
         patch.object(m.sys, 'platform', 'win32' if case == 'platform' else 'linux'), patch.object(m, '_USED', case == 'used'), \
         patch.object(m, 'load_runtime') as loaded:
        with pytest.raises(ValueError): m.main()
        loaded.assert_not_called()


def test_single_use_fence_survives_runtime_failure():
    with patch.object(m.sys, 'argv', ['launcher']), patch.object(m.sys, 'platform', 'linux'), patch.object(m, '_USED', False), \
         patch.object(m, 'load_runtime', return_value=Mock(run=Mock(side_effect=OSError('setup')))) as loaded:
        with pytest.raises(OSError): m.main()
        with pytest.raises(ValueError, match='SINGLE_USE'): m.main()
        assert loaded.call_count == 1
