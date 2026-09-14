"""Unintegrated fixed stock CONNECT refusal; import has no OS side effects."""
import base64
import hashlib
import json
import math
import os
import selectors
import socket
import stat
import time

REQUEST = (b'CONNECT api.openai.com:443 HTTP/1.1\r\n'
           b'Host: api.openai.com:443\r\nProxy-Connection: Keep-Alive\r\n\r\n')
REFUSAL = b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
NEGOTIATION_SECONDS = 2.0
READ_LIMIT = 4096
_TOKEN = object()
_cleanup_unknown = False


def identity(endpoint):
    value = os.fstat(endpoint.fileno())
    if not stat.S_ISSOCK(value.st_mode):
        raise ValueError('NOT_SOCKET')
    return {'dev': value.st_dev, 'ino': value.st_ino, 'type': stat.S_IFMT(value.st_mode)}


def fixed_prefix(previous, incoming):
    """Reject auth/other headers and early bytes without interpretation or logging."""
    candidate = previous + incoming
    if len(candidate) > len(REQUEST) or not REQUEST.startswith(candidate):
        raise ValueError('CONNECT_REFUSED')
    return candidate


def create_refusal_session(parent_deadline):
    """No address/FD/target adoption. Caller owns returned single-use session."""
    global _cleanup_unknown
    if _cleanup_unknown:
        raise ValueError('PRIOR_CLEANUP_UNKNOWN')
    began = time.monotonic()
    if type(parent_deadline) not in (int, float) or not math.isfinite(parent_deadline) or parent_deadline <= began:
        raise ValueError('PARENT_DEADLINE')
    listener = None
    try:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setblocking(False)
        listener.set_inheritable(False)
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        owner = {'address': list(listener.getsockname()), 'listener': identity(listener)}
        deadline = min(parent_deadline, began + NEGOTIATION_SECONDS)
        if time.monotonic() >= deadline:
            raise ValueError('NEGOTIATION_DEADLINE')
        return RefusalSession(listener, owner, began, deadline, _TOKEN)
    except BaseException:
        if listener is not None:
            try:
                listener.close()
            except OSError:
                _cleanup_unknown = True
        raise


class RefusalSession:
    def __init__(self, listener, ownership, began, deadline, token):
        if token is not _TOKEN:
            raise ValueError('FACTORY_ONLY')
        self.listener = listener
        self.connection = None
        self.selector = None
        self.ownership = ownership
        self.began, self.deadline = began, deadline
        self._used = False
        self._closed = False
        self._close_known = True

    def close(self):
        global _cleanup_unknown
        if self._closed:
            return self._close_known
        self._closed = True
        for endpoint in (self.connection, self.listener, self.selector):
            if endpoint is not None:
                try:
                    endpoint.close()
                except Exception:
                    self._close_known = False
        if not self._close_known:
            _cleanup_unknown = True
        return self._close_known

    def _close_listener_after_accept(self):
        global _cleanup_unknown
        try:
            self.listener.close()
        except Exception:
            # A later no-op close cannot recover knowledge lost by this attempt.
            self._close_known = False
            _cleanup_unknown = True
            raise

    def run(self, cancel=None, observer=None):
        """Observer is a source-bound trusted caller; records are not attestations."""
        if self._used or self._closed or _cleanup_unknown:
            raise ValueError('SESSION_UNAVAILABLE')
        self._used = True
        raw = bytearray()
        valid = b''
        sent = 0
        reason = None
        stage = 'selector-setup'
        accepted = None
        observations = []

        def check():
            if time.monotonic() >= self.deadline:
                raise ValueError('NEGOTIATION_DEADLINE')
            if cancel is not None and cancel.is_set():
                raise ValueError('CANCELLED')

        def observe(phase):
            if observer is None:
                return
            check()
            # A fresh copy prevents caller mutation of the captured endpoint identity.
            record = observer(phase, json.loads(json.dumps(accepted)))
            check()
            if type(record) is not dict:
                raise ValueError('OBSERVER_RECORD')
            encoded = json.dumps(record, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('ascii')
            if len(encoded) > 16384:
                raise ValueError('OBSERVER_RECORD')
            observations.append({'phase': phase, 'record': json.loads(encoded)})

        try:
            check()
            self.selector = selectors.DefaultSelector()
            self.selector.register(self.listener, selectors.EVENT_READ)
            stage = 'accept'
            while True:
                check()
                events = self.selector.select(min(0.01, max(0, self.deadline - time.monotonic())))
                check()
                for key, mask in events:
                    check()
                    if key.fileobj is self.listener:
                        try:
                            connection, peer = self.listener.accept()
                        except BlockingIOError:
                            continue
                        self.connection = connection
                        connection.setblocking(False)
                        connection.set_inheritable(False)
                        accepted = {'peer': list(peer), 'local': list(connection.getsockname()), 'socket': identity(connection)}
                        if peer[0] != '127.0.0.1' or accepted['local'] != self.ownership['address']:
                            raise ValueError('LOOPBACK_TUPLE')
                        self.selector.unregister(self.listener)
                        # Retain closed object for idempotent final cleanup, never accept again.
                        self._close_listener_after_accept()
                        self.selector.register(connection, selectors.EVENT_READ)
                        stage = 'connect-header'
                        observe('accepted-before-read')
                        check()
                        continue
                    # Even a write wakeup first observes currently queued early data.
                    try:
                        incoming = self.connection.recv(min(READ_LIMIT - len(raw), len(REQUEST) + 1))
                    except BlockingIOError:
                        incoming = None
                    check()
                    if incoming is not None:
                        if not incoming:
                            raise ValueError('CLIENT_EOF')
                        raw.extend(incoming)
                        valid = fixed_prefix(valid, incoming)
                        if valid == REQUEST:
                            observe('header-complete-before-refusal')
                            stage = 'local-refusal'
                            self.selector.modify(self.connection, selectors.EVENT_READ | selectors.EVENT_WRITE)
                    if valid == REQUEST and mask & selectors.EVENT_WRITE:
                        check()
                        try:
                            count = self.connection.send(REFUSAL[sent:])
                        except BlockingIOError:
                            continue
                        if count <= 0 or count > len(REFUSAL) - sent:
                            raise ValueError('REFUSAL_WRITE')
                        sent += count
                        check()
                        if sent == len(REFUSAL):
                            reason = 'LOCAL_PROXY_REFUSAL'
                            break
                if reason is not None:
                    break
        except Exception as exc:
            reason = str(exc) if type(exc) is ValueError and str(exc) in {
                'NEGOTIATION_DEADLINE', 'CANCELLED', 'CONNECT_REFUSED', 'CLIENT_EOF',
                'LOOPBACK_TUPLE', 'REFUSAL_WRITE', 'OBSERVER_RECORD'} else 'LOCAL_IO_FAILURE'
        finally:
            known = self.close()
        safe_raw = bytes(raw) if bytes(raw) == REQUEST else None
        return {
            'version': 1, 'profile': 'stock-noauth-connect-local-refusal',
            'reason': reason, 'stage': stage,
            'ownership': self.ownership, 'accepted': accepted,
            'provenanceObservations': observations,
            'requestBytes': len(raw), 'requestSha256': hashlib.sha256(raw).hexdigest(),
            'requestRawBase64': None if safe_raw is None else base64.b64encode(safe_raw).decode('ascii'),
            'requestRawComplete': safe_raw is not None,
            'refusalBytesWritten': sent,
            'elapsedMs': (time.monotonic() - self.began) * 1000,
            'cleanupKnown': known,
            'success': reason == 'LOCAL_PROXY_REFUSAL' and known,
            'cliProvenanceValidated': False, 'productionReady': False,
            'upstreamConnections': 0, 'tlsStarted': False, 'modelCalls': 0,
            'credentialFilesRead': 0,
        }


if __name__ == '__main__':
    raise SystemExit('CAPSULE_INTEGRATION_REQUIRED')
