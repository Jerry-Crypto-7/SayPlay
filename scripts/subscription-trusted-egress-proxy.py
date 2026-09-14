"""Credential-free offline CONNECT precursor; no production upstream connector."""
import selectors
import socket
import time

AUTHORITY = b'fixture.invalid:443'
REQUEST = b'CONNECT ' + AUTHORITY + b' HTTP/1.1\r\nHost: ' + AUTHORITY + b'\r\n\r\n'
RESPONSE = b'HTTP/1.1 200 Connection Established\r\n\r\n'
HEADER_LIMIT = 4096
QUEUE_LIMIT = 65536
BYTE_LIMIT = 1048576
NEGOTIATION_SECONDS = 2.0
SESSION_SECONDS = 5.0
_SESSION_TOKEN = object()
_UNCERTAIN_CLEANUP = False


def production_upstream():
    raise ValueError('PRODUCTION_UPSTREAM_NOT_IMPLEMENTED')


class ConnectParser:
    def __init__(self):
        self.pending = bytearray()
        self.complete = False
        self.failed = False

    def feed(self, raw):
        if self.failed or self.complete or type(raw) is not bytes or not raw:
            self.failed = True
            raise ValueError('CONNECT_STATE')
        if len(self.pending) + len(raw) > HEADER_LIMIT:
            self.failed = True; self.pending.clear()
            raise ValueError('CONNECT_HEADER_LIMIT')
        self.pending.extend(raw)
        # Only a fixed authored request is admitted. No arbitrary header values
        # are decoded, stored in diagnostics or forwarded to the opaque peer.
        if not REQUEST.startswith(self.pending):
            self.failed = True; self.pending.clear()
            raise ValueError('CONNECT_REFUSED')
        if bytes(self.pending) == REQUEST:
            self.complete = True; self.pending.clear()
        return self.complete


class OfflineSession:
    """Owns exactly three broker endpoints. Peer endpoints belong to the caller."""
    def __init__(self, ingress, upstream, control, token=None):
        if token is not _SESSION_TOKEN: raise ValueError('FIXED_OWNED_SOCKETPAIR_REQUIRED')
        self._sockets = (ingress, upstream, control)
        self._used = False
        self.cleanup_known = False

    def run(self):
        if self._used: raise ValueError('SESSION_ALREADY_USED')
        self._used = True
        ingress, upstream, control = self._sockets
        selector = None
        parser = ConnectParser()
        queues = {ingress: bytearray(), upstream: bytearray()}
        eof = set(); shut = set()
        observed = {'ingress': 0, 'upstream': 0}
        delivered = {'ingress': 0, 'upstream': 0}
        began = time.monotonic(); reason = 'UNKNOWN'; response_pending = False
        try:
            selector = selectors.DefaultSelector()
            for endpoint in self._sockets:
                endpoint.set_inheritable(False); endpoint.setblocking(False)
            while True:
                now = time.monotonic()
                if now - began >= SESSION_SECONDS: reason = 'SESSION_DEADLINE'; break
                if not parser.complete and now - began >= NEGOTIATION_SECONDS: reason = 'NEGOTIATION_DEADLINE'; break
                # Rebuild interest from bounded queues; control is always read.
                for key in list(selector.get_map().values()): selector.unregister(key.fileobj)
                selector.register(control, selectors.EVENT_READ)
                for endpoint, other in ((ingress, upstream), (upstream, ingress)):
                    events = selectors.EVENT_WRITE if queues[endpoint] else 0
                    allowed = endpoint is ingress or parser.complete
                    if allowed and endpoint not in eof and len(queues[other]) < QUEUE_LIMIT and not response_pending:
                        events |= selectors.EVENT_READ
                    if events: selector.register(endpoint, events)
                events_ready = selector.select(0.01)
                now = time.monotonic()
                if now - began >= SESSION_SECONDS:
                    return self._result('SESSION_DEADLINE', parser, observed, delivered, began)
                if not parser.complete and now - began >= NEGOTIATION_SECONDS:
                    return self._result('NEGOTIATION_DEADLINE', parser, observed, delivered, began)
                for key, events in events_ready:
                    now = time.monotonic()
                    if now - began >= SESSION_SECONDS:
                        return self._result('SESSION_DEADLINE', parser, observed, delivered, began)
                    if not parser.complete and now - began >= NEGOTIATION_SECONDS:
                        return self._result('NEGOTIATION_DEADLINE', parser, observed, delivered, began)
                    endpoint = key.fileobj
                    if endpoint is control:
                        try: command = control.recv(2)
                        except BlockingIOError: continue
                        reason = 'CANCELLED' if command in (b'', b'C') else 'CONTROL_REFUSED'
                        return self._result(reason, parser, observed, delivered, began)
                    other = upstream if endpoint is ingress else ingress
                    name = 'ingress' if endpoint is ingress else 'upstream'
                    if events & selectors.EVENT_WRITE:
                        try: count = endpoint.send(queues[endpoint])
                        except BlockingIOError: count = 0
                        if count:
                            del queues[endpoint][:count]
                            delivered[name] += count
                        if endpoint is ingress and response_pending and not queues[ingress]: response_pending = False
                    if events & selectors.EVENT_READ:
                        try: raw = endpoint.recv(min(4096, QUEUE_LIMIT - len(queues[other])))
                        except BlockingIOError: continue
                        if not raw:
                            eof.add(endpoint)
                            if not parser.complete: reason = 'CONNECT_EOF'; return self._result(reason, parser, observed, delivered, began)
                            continue
                        observed[name] += len(raw)
                        if sum(observed.values()) > BYTE_LIMIT:
                            reason = 'BYTE_LIMIT'; return self._result(reason, parser, observed, delivered, began)
                        if not parser.complete:
                            if parser.feed(raw):
                                queues[ingress].extend(RESPONSE); response_pending = True
                        else: queues[other].extend(raw)
                for endpoint, other in ((ingress, upstream), (upstream, ingress)):
                    if other in eof and not queues[endpoint] and endpoint not in shut:
                        endpoint.shutdown(socket.SHUT_WR); shut.add(endpoint)
                if len(eof) == 2 and not any(queues.values()):
                    reason = 'SESSION_DEADLINE' if time.monotonic() - began >= SESSION_SECONDS else 'EOF'
                    break
            return self._result(reason, parser, observed, delivered, began)
        except (ValueError, OSError):
            return self._result('IO_OR_PROTOCOL_REFUSED', parser, observed, delivered, began)
        finally:
            global _UNCERTAIN_CLEANUP
            try:
                if selector is not None: selector.close()
            except OSError: pass
            for endpoint in self._sockets:
                try: endpoint.close()
                except OSError: pass
            self.cleanup_known = all(endpoint.fileno() == -1 for endpoint in self._sockets)
            if not self.cleanup_known: _UNCERTAIN_CLEANUP = True
            if hasattr(self, '_report'): self._report['brokerDescriptorsClosed'] = self.cleanup_known

    def _result(self, reason, parser, observed, delivered, began):
        self._report = {'version': 1, 'profile': 'authored-offline-connect', 'reason': reason,
            'connectAccepted': parser.complete, 'observedBytes': dict(observed), 'deliveredBytes': dict(delivered),
            'elapsedMs': round((time.monotonic() - began) * 1000), 'brokerDescriptorsClosed': False,
            'productionReady': False, 'externalNetworkCalls': 0, 'modelCalls': 0}
        return self._report


def create_offline_session():
    """No TCP fallback: returns broker plus ingress/upstream/control peer sockets."""
    global _UNCERTAIN_CLEANUP
    if _UNCERTAIN_CLEANUP: raise ValueError('PREVIOUS_BROKER_CLEANUP_UNKNOWN')
    endpoints = []
    try:
        for _ in range(3):
            pair = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            endpoints.extend(pair)
            for endpoint in pair: endpoint.set_inheritable(False)
        broker = OfflineSession(endpoints[0], endpoints[2], endpoints[4], _SESSION_TOKEN)
        return broker, endpoints[1], endpoints[3], endpoints[5]
    except BaseException:
        for endpoint in endpoints:
            try: endpoint.close()
            except OSError: pass
        if any(endpoint.fileno() != -1 for endpoint in endpoints): _UNCERTAIN_CLEANUP = True
        raise


if __name__ == '__main__': production_upstream()
