"""Fixed HTTP capsule selector over the reviewed private ingress launcher."""
import hashlib
import importlib.util
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
SELF = 'subscription-trusted-http-ingress-launcher.py'
BASE = 'subscription-trusted-ingress-launcher.py'
HTTP_HELPERS = ('subscription-trusted-http-ingress.py', 'subscription-trusted-http-capsule-factory.py',
    'subscription-trusted-http-worker-probe.py', 'subscription-trusted-http-ingress-child.py')
LOADED_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
_USED = False


def load_runtime(expected=None):
    raw = (ROOT / BASE).read_bytes()
    if expected is not None and hashlib.sha256(raw).hexdigest() != expected.get(BASE): raise ValueError('HTTP_BASE_SOURCE_DRIFT')
    spec = importlib.util.spec_from_file_location('private_http_ingress_launcher', ROOT / BASE)
    runtime = importlib.util.module_from_spec(spec); exec(compile(raw, str(ROOT / BASE), 'exec'), runtime.__dict__)
    original_names = runtime.SOURCE_NAMES
    runtime.SOURCE_NAMES = tuple(dict.fromkeys((*original_names, *HTTP_HELPERS, SELF)))
    if len(runtime.SOURCE_NAMES) != 19: raise ValueError('HTTP_LAUNCHER_SOURCE_COUNT')
    runtime.COMMAND = (*runtime.COMMAND[:-1], '--trusted-http-ingress-fd')
    loaded_base_sha = hashlib.sha256(raw).hexdigest()
    original_hashes = runtime.source_hashes
    def source_hashes():
        hashes = original_hashes()
        if hashes.get(BASE) != loaded_base_sha or hashes.get(SELF) != LOADED_SHA: raise ValueError('HTTP_LOADED_SOURCE_DRIFT')
        if expected is not None and hashes != expected: raise ValueError('HTTP_RUNTIME_SOURCE_DRIFT')
        return hashes
    runtime.source_hashes = source_hashes
    return runtime


def main():
    global _USED
    if sys.argv[1:]: raise ValueError('FIXED_HTTP_LAUNCHER_NO_ARGUMENTS')
    if sys.platform != 'linux': raise ValueError('FIXED_LINUX_REQUIRED')
    if _USED: raise ValueError('HTTP_LAUNCHER_SINGLE_USE')
    _USED = True
    return load_runtime().run()


if __name__ == '__main__': raise SystemExit(main())
