"""Separate socket-role worker probe; old four-FIFO probe is unchanged."""
import hashlib
import importlib.util
import json
import os
import stat

MARKER_PATH = '/work/trusted-ingress-boundary.json'
MAX_MARKER_BYTES = 4096
BASE_PATH = '/usr/bin/trusted-control-boundary-probe.py'
KIND = 'FIXED_TRUSTED_INGRESS_BOUNDARY_OBSERVATIONS'


def load_base():
    spec = importlib.util.spec_from_file_location('private_ingress_base_probe', BASE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_marker_with(base, marker):
    if (type(marker) is not dict or set(marker) != {'version', 'namespaces', 'protectedDescriptors', 'authoredProtectedObjects', 'trustedIngressSocket'}
            or not getattr(base, '_ingress_original_marker', base.validate_marker)({key: value for key, value in marker.items() if key != 'trustedIngressSocket'})
            or not base.valid_tuple(marker['trustedIngressSocket'], stat.S_IFSOCK)):
        return False
    return base.tuple_identity(marker['trustedIngressSocket']) not in {
        base.tuple_identity(value) for value in marker['protectedDescriptors'].values()}


def read_marker_with(base):
    directory = os.open('/work', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    fd = None
    try:
        fd = os.open('trusted-ingress-boundary.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_MARKER_BYTES:
            raise ValueError('INGRESS_MARKER_REGULAR_LIMIT')
        if not os.fstatvfs(fd).f_flag & os.ST_RDONLY:
            raise ValueError('INGRESS_MARKER_READONLY_REQUIRED')
        raw = os.read(fd, MAX_MARKER_BYTES + 1)
        after = os.fstat(fd)
        if (len(raw) != before.st_size or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
            raise ValueError('INGRESS_MARKER_CHANGED')
        value = base.strict_json(raw)
        if not validate_marker_with(base, value):
            raise ValueError('INGRESS_MARKER_SCHEMA')
        return {'path': MARKER_PATH, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'rawHex': raw.hex(),
                'file': base.stat_identity(before), 'readonlyMount': True, 'value': value}
    finally:
        if fd is not None: os.close(fd)
        os.close(directory)


def adapted_base(base):
    # The supplied module is a private source-bound load, never the shared
    # four-FIFO module instance. Preserve original validators before adapting.
    if hasattr(base, '_ingress_original_validate'):
        return base, base._ingress_original_validate
    base._ingress_original_marker = base.validate_marker
    original_validate = base.validate_report
    base._ingress_original_validate = original_validate
    base.MARKER_PATH = MARKER_PATH
    base.PROC_FD_PATHS = (*base.PROC_FD_PATHS, '/proc/1/fd/198')
    base.validate_marker = lambda value: validate_marker_with(base, value)
    base.read_marker = lambda: read_marker_with(base)
    return base, original_validate


def collect_with(base):
    adapted, _ = adapted_base(base)
    report = adapted.collect()
    report['kind'] = KIND
    return report


def validate_report_with(base, report, expected_marker):
    try:
        if type(report) is not dict or report.get('kind') != KIND or not validate_marker_with(base, expected_marker):
            return False
        adapted, validator = adapted_base(base)
        # Only the private validation view's kind is normalized; observed raw
        # marker bytes, socket role, paths and report remain unchanged.
        view = {**report, 'kind': 'FIXED_TRUSTED_CONTROL_BOUNDARY_OBSERVATIONS'}
        if not validator(view, expected_marker): return False
        protected = adapted.tuple_identity(expected_marker['trustedIngressSocket'])
        descriptors = list(report['descriptors']) + [value['descriptor'] for value in report['paths'].values() if value['opened']]
        return all(adapted.tuple_identity(value) != protected for value in descriptors)
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
        return False


if __name__ == '__main__':
    print(json.dumps(collect_with(load_base()), separators=(',', ':'), allow_nan=False), flush=True)
