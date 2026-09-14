"""Fixed authored HTTP CONNECT ingress; no DNS, production upstream or auth."""
import errno
import os
import selectors
import socket
import stat
import time

REQUEST = b'CONNECT fixture.invalid:443 HTTP/1.1\r\nHost: fixture.invalid:443\r\n\r\n'
PINNED_WSS_REQUEST = REQUEST[:-2] + b'Proxy-Connection: Keep-Alive\r\n\r\n'
RESPONSE = b'HTTP/1.1 200 Connection Established\r\n\r\n'
HEADER_LIMIT = 4096
QUEUE_LIMIT = 65536
BYTE_LIMIT = 1048576
NEGOTIATION_SECONDS = 2.0
SESSION_SECONDS = 5.0
_TOKEN = object()
_UNCERTAIN_CLEANUP = False


def production_upstream():
    raise ValueError('PRODUCTION_UPSTREAM_NOT_IMPLEMENTED')


def identity(endpoint):
    value = os.fstat(endpoint.fileno())
    if not stat.S_ISSOCK(value.st_mode): raise ValueError('SOCKET_REQUIRED')
    return {'dev': value.st_dev, 'ino': value.st_ino, 'type': stat.S_IFMT(value.st_mode)}


def close_all(handles):
    global _UNCERTAIN_CLEANUP
    outcomes = []
    for handle in handles:
        if handle is None: continue
        try: handle.close(); outcomes.append(True)
        except Exception: outcomes.append(False)
    if not all(outcomes): _UNCERTAIN_CLEANUP = True
    return outcomes


def fixed_prefix(pending, raw, expected):
    if type(raw) is not bytes or not raw: raise ValueError('HANDSHAKE_INPUT')
    if len(pending) + len(raw) > HEADER_LIMIT: raise ValueError('HEADER_LIMIT')
    candidate = bytes(pending) + raw
    if not expected.startswith(candidate): raise ValueError('HANDSHAKE_REFUSED')
    pending.extend(raw)
    return candidate == expected


class OfflineSession:
    def __init__(self, listener, ingress, control, expected_client, ownership, began, token=None, profile='authored-connect'):
        if token is not _TOKEN: raise ValueError('FACTORY_OWNED_ENDPOINTS_REQUIRED')
        if profile not in ('authored-connect', 'pinned-wss-shaped-fixture'): raise ValueError('FIXED_PROFILE_REQUIRED')
        self.profile = profile
        self.client_request = PINNED_WSS_REQUEST if profile == 'pinned-wss-shaped-fixture' else REQUEST
        self.listener, self.ingress, self.control = listener, ingress, control
        self.expected_client, self.ownership, self.began = expected_client, ownership, began
        self._used = False
        self._handles = [listener, ingress, control]
        self._cleanup = None

    def close(self):
        if self._cleanup is None:
            self._used = True
            outcomes = close_all(self._handles)
            self._cleanup = {'closed': outcomes, 'known': all(outcomes), 'processCleanup': 'NOT_ATTESTED'}
        return self._cleanup

    def run(self):
        if self._used: raise ValueError('SESSION_ALREADY_USED')
        self._used = True
        listener, ingress, control = self.listener, self.ingress, self.control
        accepted = selector = None
        state, reason = 'ACCEPT', 'UNKNOWN'
        observed = {'client': 0, 'ingress': 0}
        delivered = {'client': 0, 'ingress': 0}
        queues = {'client': bytearray(), 'ingress': bytearray()}
        request, response = bytearray(), bytearray()
        eof, shut = set(), set()
        result = {'profile': self.profile, 'normalizedHeaderBytes': 0, 'productionReady': False, 'modelCalls': 0, 'credentialFilesRead': 0,
                  'ownership': self.ownership}
        def deadline():
            elapsed = time.monotonic() - self.began
            if elapsed >= SESSION_SECONDS: raise ValueError('SESSION_DEADLINE')
            if state != 'RELAY' and elapsed >= NEGOTIATION_SECONDS: raise ValueError('NEGOTIATION_DEADLINE')
        try:
            deadline()
            selector = selectors.DefaultSelector(); self._handles.append(selector)
            while True:
                deadline()
                for key in list(selector.get_map().values()): selector.unregister(key.fileobj)
                selector.register(control, selectors.EVENT_READ, 'control')
                if accepted is None:
                    selector.register(listener, selectors.EVENT_READ, 'listener')
                else:
                    for name, endpoint, other in (('client', accepted, 'ingress'), ('ingress', ingress, 'client')):
                        events = selectors.EVENT_WRITE if queues[name] else 0
                        if name not in eof and len(queues[other]) < QUEUE_LIMIT:
                            # Reading early ingress/client bytes is deliberate: reject pipelining.
                            events |= selectors.EVENT_READ
                        if events: selector.register(endpoint, events, name)
                ready = selector.select(0.01)
                deadline()
                # Cancellation cannot starve behind saturated data sockets.
                ready.sort(key=lambda item: item[0].data != 'control')
                for key, events in ready:
                    deadline()
                    name, endpoint = key.data, key.fileobj
                    if name == 'control':
                        try: raw = endpoint.recv(2)
                        except BlockingIOError: continue
                        raise ValueError('CANCELLED' if raw == b'C' else 'CONTROL_EOF' if not raw else 'CONTROL_INVALID')
                    if name == 'listener':
                        try:
                            accepted, peer = listener.accept(); self._handles.append(accepted)
                        except BlockingIOError: continue
                        accepted.setblocking(False); accepted.set_inheritable(False)
                        if peer != self.expected_client or accepted.getsockname() != tuple(self.ownership['address']):
                            raise ValueError('CLIENT_IDENTITY_MISMATCH')
                        self.ownership['accepted'] = identity(accepted)
                        listener.close(); state = 'CLIENT_CONNECT'
                        continue
                    other = 'ingress' if name == 'client' else 'client'
                    if events & selectors.EVENT_READ:
                        capacity = min(4096, QUEUE_LIMIT - len(queues[other]), BYTE_LIMIT - sum(observed.values()) + 1)
                        try: raw = endpoint.recv(capacity)
                        except BlockingIOError: raw = None
                        deadline()
                        if raw is not None:
                            observed[name] += len(raw)
                            if sum(observed.values()) > BYTE_LIMIT: raise ValueError('OUTPUT_LIMIT')
                            if not raw:
                                if state != 'RELAY': raise ValueError('HANDSHAKE_EOF')
                                eof.add(name)
                            elif state == 'CLIENT_CONNECT' and name == 'client':
                                if fixed_prefix(request, raw, self.client_request):
                                    result['normalizedHeaderBytes'] = len(self.client_request) - len(REQUEST)
                                    queues['ingress'].extend(REQUEST); request.clear(); state = 'BROKER_CONNECT'
                            elif state == 'BROKER_CONNECT' and name == 'ingress' and delivered['ingress'] == len(REQUEST) and not queues['client']:
                                if fixed_prefix(response, raw, RESPONSE):
                                    queues['client'].extend(response); response.clear(); state = 'CLIENT_RESPONSE'
                            elif state == 'RELAY': queues[other].extend(raw)
                            else: raise ValueError('EARLY_DATA')
                    if events & selectors.EVENT_WRITE and queues[name]:
                        deadline()
                        try: count = endpoint.send(queues[name])
                        except BlockingIOError: continue
                        if count <= 0: raise ValueError('WRITE_NO_PROGRESS')
                        delivered[name] += count; del queues[name][:count]
                        deadline()
                        if state == 'CLIENT_RESPONSE' and name == 'client' and not queues[name]: state = 'RELAY'
                if state == 'RELAY':
                    for name, endpoint, other in (('client', ingress, 'ingress'), ('ingress', accepted, 'client')):
                        if name in eof and name not in shut and not queues[other]:
                            deadline(); endpoint.shutdown(socket.SHUT_WR); shut.add(name)
                    if len(eof) == 2 and not any(queues.values()):
                        deadline(); reason = 'EOF'; break
        except (OSError, ValueError) as error:
            reason = str(error) if isinstance(error, ValueError) else 'OS_ERROR'
        except Exception:
            reason = 'INTERNAL_ERROR'
        finally:
            result.update(reason=reason, state=state, observedBytes=observed, deliveredBytes=delivered,
                          retainedBytes={name: len(value) for name, value in queues.items()},
                          handshakeRetainedBytes={'request': len(request), 'response': len(response)},
                          elapsedMs=(time.monotonic() - self.began) * 1000)
            result['cleanup'] = self.close()
            result['success'] = reason == 'EOF' and result['cleanup']['known']
        return result


def create_offline_session():
    """Original exact67-byte authored client entry."""
    return _create('authored-connect')


def create_pinned_wss_fixture_session():
    """Fixed97-byte source-shaped fixture; not an actual WSS/TLS client."""
    return _create('pinned-wss-shaped-fixture')


def _create(profile):
    """Return (session, connected client, ingress peer, cancellation peer)."""
    if _UNCERTAIN_CLEANUP: raise ValueError('PREVIOUS_CLEANUP_UNKNOWN')
    began = time.monotonic(); owned = []
    try:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM); owned.append(listener)
        listener.set_inheritable(False); listener.setblocking(False)
        listener.bind(('127.0.0.1', 0)); listener.listen(1)
        address = listener.getsockname()
        if address[0] != '127.0.0.1' or not listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN):
            raise ValueError('FIXED_LISTENER_REQUIRED')
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM); owned.append(client)
        client.set_inheritable(False); client.bind(('127.0.0.1', 0)); expected = client.getsockname()
        client.setblocking(False)
        connected = client.connect_ex(address)
        if connected not in (0, errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY): raise ValueError('CLIENT_CONNECT_FAILED')
        if connected:
            connector = selectors.DefaultSelector(); owned.append(connector)
            connector.register(client, selectors.EVENT_WRITE)
            remaining = NEGOTIATION_SECONDS - (time.monotonic() - began)
            if remaining <= 0 or not connector.select(remaining): raise ValueError('NEGOTIATION_DEADLINE')
            if time.monotonic() - began >= NEGOTIATION_SECONDS: raise ValueError('NEGOTIATION_DEADLINE')
            if client.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR): raise ValueError('CLIENT_CONNECT_FAILED')
            connector.close(); owned.remove(connector)
        ingress, ingress_peer = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM); owned.extend((ingress, ingress_peer))
        control, control_peer = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM); owned.extend((control, control_peer))
        for endpoint in (ingress, ingress_peer, control, control_peer):
            endpoint.setblocking(False); endpoint.set_inheritable(False)
        ownership = {'address': list(address), 'expectedClient': list(expected), 'listener': identity(listener),
                     'ingress': identity(ingress), 'networkNamespace': os.readlink('/proc/self/ns/net')}
        if time.monotonic() - began >= NEGOTIATION_SECONDS: raise ValueError('NEGOTIATION_DEADLINE')
        return OfflineSession(listener, ingress, control, expected, ownership, began, _TOKEN, profile), client, ingress_peer, control_peer
    except BaseException:
        close_all(owned)
        raise



