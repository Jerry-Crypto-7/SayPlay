"""Fixed credential-free metadata CLI to owned refusing proxy composition."""
import base64
import hashlib
import json
import math
import os
import re
import signal
import stat
import sys
import threading
import time
import types

HELPERS = {
 'subscription-exec-server-worker-gate.py':'/usr/bin/exec-server-worker-gate.py',
 'subscription-exec-server-worker-trampoline.py':'/usr/bin/exec-server-worker-trampoline.py',
 'subscription-exec-worker-probe.py':'/usr/bin/exec-worker-probe.py',
 'subscription-worker-lockdown.py':'/usr/bin/worker-lockdown.py',
 'subscription-appserver-noenv.py':'/usr/bin/appserver-noenv.py',
 'subscription-text-model-catalog.json':'/usr/bin/text-model-catalog.json',
 'subscription-exec-environment-metadata-parent.py':'/usr/bin/exec-environment-metadata-parent.py',
 'subscription-cli-proxy-refusal.py':'/usr/bin/cli-proxy-refusal.py',
 'subscription-cli-proxy-provenance.py':'/usr/bin/cli-proxy-provenance.py',
 'subscription-cli-proxy-refusal-child.py':'/usr/bin/cli-proxy-refusal-child.py'}
CATALOG_SHA256 = '59d22b4ae6532d4f869d776e56faaf2ae169f36038375597f4f1e581459b8791'


def same(a, b):
    return json.dumps(a, sort_keys=True, allow_nan=False) == json.dumps(b, sort_keys=True, allow_nan=False)


def fixed_bytes(name):
    fd = os.open(HELPERS[name], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        first = os.fstat(fd)
        if not stat.S_ISREG(first.st_mode) or not 0 < first.st_size <= 1024 * 1024 or not os.fstatvfs(fd).f_flag & os.ST_RDONLY:
            raise ValueError('READONLY_HELPER_REQUIRED')
        raw = os.read(fd, 1024 * 1024 + 1)
        last = os.fstat(fd)
        if len(raw) != first.st_size or (first.st_dev, first.st_ino, first.st_mtime_ns) != (last.st_dev, last.st_ino, last.st_mtime_ns):
            raise ValueError('HELPER_CHANGED')
        return raw
    finally:
        os.close(fd)


def hashes():
    result = {name: hashlib.sha256(fixed_bytes(name)).hexdigest() for name in HELPERS}
    if result['subscription-text-model-catalog.json'] != CATALOG_SHA256:
        raise ValueError('CATALOG_HASH')
    return result


def load_fixed(name):
    value = types.ModuleType('private_refusal_' + name.replace('-', '_'))
    value.__file__ = HELPERS[name]
    exec(compile(fixed_bytes(name), value.__file__, 'exec'), value.__dict__)
    return value


def private_namespace(module, **overrides):
    result = types.SimpleNamespace(**vars(module))
    for key, value in overrides.items(): setattr(result, key, value)
    return result


def own_generation(process, pin, provenance, deadline):
    def check():
        if time.monotonic() >= deadline: raise ValueError('PROVENANCE_SETUP_DEADLINE')
    check()
    signal.pidfd_send_signal(pin, 0)
    check()
    fd = os.open('/proc/' + str(process.pid) + '/stat', os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        check(); raw = os.read(fd, 4097); check()
        if len(raw) > 4096: raise ValueError('OWN_STAT_LIMIT')
    finally: os.close(fd)
    ticks = provenance.stat_identity(raw, process.pid)
    net = os.readlink('/proc/self/ns/net'); check()
    signal.pidfd_send_signal(pin, 0); check()
    return {'pid': process.pid, 'startTicks': ticks, 'networkNamespace': net}


class Composition:
    """Private parent hooks; no globally patched subprocess/OS modules."""
    def __init__(self, parent, policy, gate, core, provenance, began):
        self.parent, self.policy, self.gate, self.core, self.provenance = parent, policy, gate, core, provenance
        self.began = began; self.session = None; self.observer = None; self.pin = None
        self.process = None; self.identity = None; self.thread = None; self.proxy_report = None
        self.error = None; self.cancel = threading.Event(); self.finished = threading.Event()
        self.read_fd = None; self.write_fd = None
        self.selector = None; self._selector_issued = False
        self._closed = False
        self.cleanup = {'sessionClosed': False, 'threadJoined': False, 'observerPinClosed': False,
                        'originalPinClosed': False, 'notificationReadClosed': False, 'notificationWriteClosed': False}

    def failed(self):
        self.error = self.error or 'PROXY_REFUSAL_INCOMPLETE'
        if self.write_fd is not None:
            try: os.write(self.write_fd, b'F')
            except BlockingIOError: pass  # Existing byte already keeps failure readable.
            except OSError: self.error = 'PROXY_FAILURE_NOTIFICATION_UNKNOWN'

    def execute_proxy(self):
        try:
            self.proxy_report = self.session.run(self.cancel, self.observer)
            if self.proxy_report.get('success') is not True: self.failed()
        except BaseException:
            self.failed()
        finally: self.finished.set()

    def install(self):
        p = self.parent
        self.session = self.core.create_refusal_session(self.began + p.METADATA_SECONDS)
        self.read_fd, self.write_fd = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        original_home, original_popen = p.prepare_home, p.subprocess.Popen
        original_progress, original_selector = p.bootstrap_progress, p.selectors.DefaultSelector
        original_read = p.os.read
        expected_env = None
        # Parent creates its selector after Popen but before its cleanup try.
        # Complete all fallible construction/registration now, before any spawn.
        self.selector = original_selector()
        self.selector.register(NotificationFD(self.read_fd), p.selectors.EVENT_READ, 'proxy-failure')

        def home(bootstrap=False):
            nonlocal expected_env
            if bootstrap is not True: raise ValueError('CONTROLLED_BOOTSTRAP_ONLY')
            env = original_home(bootstrap=True)
            if set(env) != {'PATH', 'LANG', 'HOME', 'CODEX_HOME', 'TMPDIR'}:
                raise ValueError('CLEAN_PARENT_ENV_REQUIRED')
            expected_env = {**env, 'HTTPS_PROXY': 'http://127.0.0.1:' + str(self.session.ownership['address'][1])}
            return dict(expected_env)

        def popen(argv, **kwargs):
            if self.process is not None or argv != p.fixed_argv(self.policy, True) or set(kwargs) != {'cwd','env','stdin','stdout','stderr','close_fds'} or kwargs['cwd'] != '/work' or not same(kwargs['env'], expected_env) or kwargs['close_fds'] is not True or any(kwargs[k] != p.subprocess.PIPE for k in ('stdin','stdout','stderr')):
                raise ValueError('FIXED_CLI_SPAWN_REQUIRED')
            self.process = original_popen(argv, **kwargs)
            # Once Popen succeeds always return it to parent's normal cleanup path.
            try:
                self.pin = os.pidfd_open(self.process.pid)
                self.identity = own_generation(self.process, self.pin, self.provenance, self.session.deadline)
                self.observer = self.provenance.create_observer(self.process, self.pin,
                    self.identity['startTicks'], self.identity['networkNamespace'], self.session.deadline)
                self.thread = threading.Thread(target=self.execute_proxy, daemon=True, name='fixed-cli-proxy-refusal')
                self.thread.start()
            except BaseException:
                self.failed(); self.finished.set()
            return self.process

        def selector():
            if self._selector_issued: raise ValueError('SELECTOR_ALREADY_ISSUED')
            self._selector_issued = True
            return self.selector

        def read(fd, count):
            if fd == self.read_fd:
                # Existing inner parent IO exception handler starts normal cleanup.
                raise ValueError('PROXY_REFUSAL_INCOMPLETE')
            return original_read(fd, count)

        def progress(*args):
            if self.error: return 'failed', None, self.error
            result = original_progress(*args)
            if result[0] == 'ready' and not self.finished.is_set(): return 'pending', None, None
            return result

        p.prepare_home = home; p.bootstrap_progress = progress
        p.subprocess = private_namespace(p.subprocess, Popen=popen)
        p.selectors = private_namespace(p.selectors, DefaultSelector=selector)
        p.os = private_namespace(p.os, read=read)

    def close(self):
        if self._closed: return all(self.cleanup.values())
        self._closed = True
        self.cancel.set()
        if self.thread is not None and self.thread.ident is not None:
            self.thread.join(timeout=max(0, min(0.1, self.began + self.parent.HARD_SECONDS - time.monotonic())))
            self.cleanup['threadJoined'] = not self.thread.is_alive()
        else: self.cleanup['threadJoined'] = True
        if self.cleanup['threadJoined']:
            self.cleanup['sessionClosed'] = self.session is None or self.session.close() is True
            self.cleanup['observerPinClosed'] = self.observer is None or self.observer.close().get('closed') is True
        if self.selector is not None:
            try: self.selector.close()
            except Exception: self.cleanup['sessionClosed'] = False
        for attr, key in (('pin','originalPinClosed'), ('read_fd','notificationReadClosed'), ('write_fd','notificationWriteClosed')):
            if not self.cleanup['threadJoined'] and attr in ('read_fd','write_fd'):
                # A live producer may still signal. Never close/reuse its channel.
                self.cleanup[key] = False
                continue
            fd = getattr(self, attr)
            if fd is None: self.cleanup[key] = True
            else:
                try: os.close(fd); self.cleanup[key] = True
                except OSError: self.cleanup[key] = False
                setattr(self, attr, None)
        return all(self.cleanup.values())


class NotificationFD:
    """Nonowning file-object contract required by the reused parent's event path."""
    def __init__(self, fd): self.fd = fd
    def fileno(self): return self.fd


def validate_report(report, deps):
    try:
        parent, policy, gate, core, provenance = deps
        if type(report) is not dict or set(report) != {'version','profile','success','error','parentReport','proxyReport','cliIdentity','cleanup','helperSha256Before','helperSha256After','elapsedMs'}: return False
        if type(report['version']) is not int or report['version'] != 1 or report['profile'] != 'fixed-cli-proxy-refusal-child' or report['success'] is not True or report['error'] is not None: return False
        h = report['helperSha256Before']
        if type(h) is not dict or set(h) != set(HELPERS) or not same(h, report['helperSha256After']) or any(type(x) is not str or re.fullmatch('[a-f0-9]{64}', x) is None for x in h.values()) or h['subscription-text-model-catalog.json'] != CATALOG_SHA256: return False
        pr = report['parentReport']
        if not parent.validate_controlled_bootstrap_report(pr, policy, gate) or not same(pr['helperSha256Before'], {k:h[k] for k in parent.HELPER_FILES}): return False
        if type(report['elapsedMs']) not in (int,float) or not math.isfinite(report['elapsedMs']) or not 0 <= report['elapsedMs'] < parent.HARD_SECONDS * 1000 or pr['elapsedMs'] > report['elapsedMs'] + 0.5: return False
        cleanup = report['cleanup']
        if type(cleanup) is not dict or set(cleanup) != {'sessionClosed','threadJoined','observerPinClosed','originalPinClosed','notificationReadClosed','notificationWriteClosed'} or any(v is not True for v in cleanup.values()): return False
        r = report['proxyReport']
        expected_keys = {'version','profile','reason','stage','ownership','accepted','provenanceObservations','requestBytes','requestSha256','requestRawBase64','requestRawComplete','refusalBytesWritten','elapsedMs','cleanupKnown','success','cliProvenanceValidated','productionReady','upstreamConnections','tlsStarted','modelCalls','credentialFilesRead'}
        if type(r) is not dict or set(r) != expected_keys: return False
        if r['profile'] != 'stock-noauth-connect-local-refusal' or r['reason'] != 'LOCAL_PROXY_REFUSAL' or r['stage'] != 'local-refusal' or type(r['version']) is not int or r['version'] != 1: return False
        if any(r[k] is not True for k in ('requestRawComplete','cleanupKnown','success')) or any(r[k] is not False for k in ('cliProvenanceValidated','productionReady','tlsStarted')): return False
        if any(type(r[k]) is not int or r[k] != 0 for k in ('upstreamConnections','modelCalls','credentialFilesRead')): return False
        if type(r['requestBytes']) is not int or r['requestBytes'] != len(core.REQUEST) or r['requestSha256'] != hashlib.sha256(core.REQUEST).hexdigest() or r['requestRawBase64'] != base64.b64encode(core.REQUEST).decode(): return False
        if type(r['refusalBytesWritten']) is not int or r['refusalBytesWritten'] != len(core.REFUSAL) or type(r['elapsedMs']) not in (int,float) or not math.isfinite(r['elapsedMs']) or not 0 <= r['elapsedMs'] < 2000: return False
        if not provenance.valid_observation(r['accepted']) or type(r['ownership']) is not dict or set(r['ownership']) != {'address','listener'} or r['ownership']['address'] != r['accepted']['local']: return False
        listener = r['ownership']['listener']
        if type(listener) is not dict or set(listener) != {'dev','ino','type'} or any(type(x) is not int or x < 0 for x in listener.values()) or listener['ino'] <= 0 or listener['type'] != 49152 or same(listener,r['accepted']['socket']): return False
        records = r['provenanceObservations']
        if type(records) is not list or len(records) != 2 or any(type(item) is not dict or set(item) != {'phase','record'} or item['phase'] != phase for item,phase in zip(records,provenance.PHASES)): return False
        identity = report['cliIdentity']
        return (type(identity) is dict and identity.get('pid') == pr['directChild']['pid'] and type(identity.get('pid')) is int
                and provenance.validate_records([x['record'] for x in records], identity, r['accepted']))
    except (ValueError, TypeError, KeyError, AttributeError, IndexError): return False


def seal_report(report, deps, began):
    """Final hashes and replay remain inside the original total work budget."""
    report['helperSha256After'] = hashes()
    report['elapsedMs'] = (time.monotonic() - began) * 1000
    valid = validate_report(report, deps)
    report['elapsedMs'] = (time.monotonic() - began) * 1000
    if not 0 <= report['elapsedMs'] < deps[0].HARD_SECONDS * 1000:
        report['success'] = False; report['error'] = report['error'] or 'REFUSAL_CHILD_TOTAL_DEADLINE'
    elif not valid:
        report['success'] = False; report['error'] = report['error'] or 'REFUSAL_CHILD_REPORT_INVALID'
    return report


def main():
    if sys.platform != 'linux' or sys.argv[1:]: raise ValueError('FIXED_CAPSULE_ENTRY_REQUIRED')
    began = time.monotonic(); before = hashes()
    names = ('subscription-exec-environment-metadata-parent.py','subscription-appserver-noenv.py','subscription-exec-server-worker-gate.py','subscription-cli-proxy-refusal.py','subscription-cli-proxy-provenance.py')
    deps = tuple(load_fixed(name) for name in names)
    parent, policy, gate, core, provenance = deps
    composition = Composition(*deps, began)
    report = {'version':1,'profile':'fixed-cli-proxy-refusal-child','success':False,'error':None,'parentReport':None,'proxyReport':None,'cliIdentity':None,'cleanup':None,'helperSha256Before':before,'helperSha256After':None,'elapsedMs':None}
    try:
        composition.install()
        pr = parent.run_parent(policy, began, bootstrap=True, gate=gate, controlled=True)
        report['parentReport'] = pr
        pr['helperSha256Before'] = {k:before[k] for k in parent.HELPER_FILES}
        pr['environmentHook'] = parent.read_hook(policy, gate, bootstrap=True)
        pr['helperSha256After'] = parent.helper_hashes()
    except Exception:
        report['error'] = 'REFUSAL_CHILD_RUNTIME_FAILURE'
    finally:
        composition.close()
        report.update(proxyReport=composition.proxy_report, cliIdentity=composition.identity, cleanup=composition.cleanup)
    report['error'] = report['error'] or composition.error
    report['success'] = report['error'] is None
    # Validate with a fresh unmodified parent; runtime hooks never weaken replay.
    replay_deps = (load_fixed(names[0]), policy, gate, core, provenance)
    seal_report(report, replay_deps, began)
    print(json.dumps(report, separators=(',', ':'), allow_nan=False), flush=True)
    return 0 if report['success'] else 1


if __name__ == '__main__': raise SystemExit(main())
