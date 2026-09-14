"""Offline probe contract tests; no actual syscall/namespace runtime."""
import errno
import importlib.util
from pathlib import Path
from unittest.mock import Mock

import pytest

spec = importlib.util.spec_from_file_location('exec_worker_probe', Path(__file__).with_name('subscription-exec-worker-probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


@pytest.fixture(autouse=True)
def mocked_linux_open_flags(monkeypatch):
    # Offline open() doubles never reach the host kernel.
    monkeypatch.setattr(probe.os, 'O_NONBLOCK', 0x800, raising=False)
    monkeypatch.setattr(probe.os, 'O_CLOEXEC', 0x80000, raising=False)


def test_denied_open_preserves_errno_without_read(monkeypatch):
    monkeypatch.setattr(probe.os, 'open', Mock(side_effect=PermissionError(errno.EACCES, 'denied')))
    assert probe.open_probe('/private/sentinel') == {
        'opened': False, 'errno': errno.EACCES, 'bytesRead': 0, 'bytesWritten': 0}


def test_successful_open_is_reported_and_closed_without_read(monkeypatch):
    monkeypatch.setattr(probe.os, 'open', Mock(return_value=19))
    close = Mock()
    monkeypatch.setattr(probe.os, 'close', close)
    monkeypatch.setattr(probe, 'descriptor', lambda fd: {'fd': fd})
    result = probe.open_probe('/private/sentinel')
    assert result['opened'] is True and result['bytesRead'] == 0
    close.assert_called_once_with(19)


def test_open_descriptor_error_still_closes(monkeypatch):
    monkeypatch.setattr(probe.os, 'open', Mock(return_value=19))
    close = Mock()
    monkeypatch.setattr(probe.os, 'close', close)
    monkeypatch.setattr(probe, 'descriptor', Mock(side_effect=OSError('failed')))
    with pytest.raises(OSError):
        probe.open_probe('/private/sentinel')
    close.assert_called_once_with(19)


def test_no_caller_arguments(monkeypatch):
    monkeypatch.setattr(probe.sys, 'argv', ['probe', 'extra'])
    with pytest.raises(ValueError, match='FIXED_EXEC_WORKER_CAPSULE_REQUIRED'):
        probe.collect()


def test_wrong_platform_stops_before_probes(monkeypatch):
    monkeypatch.setattr(probe.sys, 'argv', ['probe'])
    monkeypatch.setattr(probe.sys, 'platform', 'win32')
    with pytest.raises(ValueError, match='FIXED_EXEC_WORKER_CAPSULE_REQUIRED'):
        probe.collect()


def test_namespace_metadata_preserves_denial(monkeypatch):
    monkeypatch.setattr(probe.os, 'readlink', Mock(side_effect=PermissionError(errno.EACCES, 'denied')))
    assert probe.namespace_metadata('/proc/1/ns/pid') == {'value': None, 'errno': errno.EACCES}


def test_namespace_metadata_reports_observed_identity(monkeypatch):
    monkeypatch.setattr(probe.os, 'readlink', Mock(return_value='pid:[123]'))
    assert probe.namespace_metadata('/proc/1/ns/pid') == {'value': 'pid:[123]', 'errno': None}
