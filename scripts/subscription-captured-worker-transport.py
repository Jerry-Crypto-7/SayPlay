"""Bounded adapter/final-wire transports and a socket pump; no process launcher."""
import hashlib
import math
import selectors
import socket
import time
import types

ADAPTER_SHA = 'b62eb84b77a06e638a6027343a49134b876bb0d3550044e3740da80774bd17ff'
SIDES = ('client', 'worker')
MAX_BYTES = 1048576
MAX_CALLS = 4096


def need(value, reason):
    if not value:
        raise ValueError(reason)


class Transport:
    def __init__(self, adapter_raw, base_raw, process_id, thread_id):
        need(type(adapter_raw) is bytes and hashlib.sha256(adapter_raw).hexdigest() == ADAPTER_SHA, 'ADAPTER_SOURCE')
        module = types.ModuleType('pinned_captured_adapter')
        exec(compile(adapter_raw, '<pinned-captured-adapter>', 'exec'), module.__dict__)
        self.adapter = module.ReadAdapter(base_raw, process_id, thread_id)
        self.encode = module.encode
        self._input = {side: bytearray() for side in SIDES}
        self._pending = {side: bytearray() for side in SIDES}
        self._eof = {side: False for side in SIDES}
        self.enqueued = {side: 0 for side in SIDES}
        self.writes = {side: 0 for side in SIDES}
        self.input_bytes = 0
        self.start_end = None
        self.start_reply_end = None
        self.read_end = None
        self.calls = []
        self.failed = False

    def _guard(self, side):
        need(not self.failed and type(side) is str and side in SIDES, 'TRANSPORT_STATE')
        need(len(self.calls) < MAX_CALLS, 'CALL_LIMIT')

    def _fail(self):
        self.failed = True
        self.adapter.failed = True
        for side in SIDES:
            self._input[side].clear()
            self._pending[side].clear()

    def pending(self, side):
        """Immutable bytes to write to this destination; empty after failure."""
        need(type(side) is str and side in SIDES, 'SIDE')
        return bytes(self._pending[side])

    def _enqueue(self, side, raw):
        need(sum(self.enqueued.values()) + len(raw) <= MAX_BYTES, 'OUTPUT_LIMIT')
        self._pending[side].extend(raw)
        self.enqueued[side] += len(raw)

    def _frame(self, side, raw):
        a = self.adapter
        frame = a.parse(raw)
        need(type(frame) is dict, 'FRAME_SHAPE')
        if side == 'client':
            if a.stage == 0:
                self._enqueue('worker', a.start(raw))
                self.start_end = self.enqueued['worker']
            else:
                need(self.start_reply_end is not None and
                     self.writes['client'] >= self.start_reply_end, 'START_REPLY_NOT_WRITTEN')
                self._enqueue('worker', a.read(raw))
                self.read_end = self.enqueued['worker']
        else:
            need(self.start_end is not None and self.writes['worker'] >= self.start_end, 'START_NOT_WRITTEN')
            if 'method' in frame:
                self._enqueue('client', a.notification(raw))
            elif a.stage == 1:
                self._enqueue('client', a.reply(raw))
                self.start_reply_end = self.enqueued['client']
            else:
                need(self.read_end is not None and self.writes['worker'] >= self.read_end, 'READ_NOT_WRITTEN')
                self._enqueue('client', a.read_reply(raw))
                self.read_end = None

    def feed(self, side, raw):
        """Actual bytes read from side; accepts split and coalesced JSON lines."""
        try:
            self._guard(side)
            need(not self._eof[side] and not (side == 'client' and self._eof['worker']), 'INPUT_CLOSED')
            need(type(raw) is bytes and 0 < len(raw) <= 131072, 'INPUT_CHUNK')
            need(self.input_bytes + len(raw) <= MAX_BYTES, 'INPUT_LIMIT')
            self.input_bytes += len(raw)
            self._input[side].extend(raw)
            buffer = self._input[side]
            while b'\n' in buffer:
                end = buffer.index(b'\n') + 1
                need(end <= 131072, 'LINE_LIMIT')
                line = bytes(buffer[:end])
                del buffer[:end]
                self._frame(side, line)
            need(len(buffer) < 131072, 'LINE_LIMIT')
            self.calls.append({'op': 'feed', 'side': side, 'rawHex': raw.hex()})
        except BaseException:
            self._fail()
            raise

    def written(self, side, count):
        """Positive count returned by the caller's write; never a planned size."""
        try:
            self._guard(side)
            need(type(count) is int and 0 < count <= len(self._pending[side]), 'WRITE_COUNT')
            del self._pending[side][:count]
            self.writes[side] += count
            self.calls.append({'op': 'written', 'side': side, 'count': count})
        except BaseException:
            self._fail()
            raise

    def eof(self, side):
        """Input EOF only; client half-close may precede worker completion."""
        try:
            self._guard(side)
            need(not self._eof[side] and not self._input[side], 'EOF_PARTIAL_OR_DUPLICATE')
            need(self.adapter.stage > 0, 'EOF_BEFORE_START')
            if side == 'worker':
                need(self.adapter.report()['complete'], 'WORKER_EOF_INCOMPLETE')
            self._eof[side] = True
            self.calls.append({'op': 'eof', 'side': side})
        except BaseException:
            self._fail()
            raise

    def abort(self):
        """Call after write/read failure, timeout or external cancellation."""
        self._fail()

    def report(self):
        protocol = self.adapter.report()
        complete = (not self.failed and protocol['complete'] and all(self._eof.values()) and
                    not any(self._pending.values()) and not any(self._input.values()))
        return {'version': 1, 'profile': 'captured-worker-duplex-accounting',
                'adapterSha256': ADAPTER_SHA, 'protocol': protocol,
                'calls': [dict(call) for call in self.calls], 'inputBytes': self.input_bytes,
                'enqueuedBytes': dict(self.enqueued), 'writtenBytes': dict(self.writes),
                'inputEof': dict(self._eof), 'complete': complete, 'failed': self.failed,
                'writeAccountingComplete': complete, 'deliveryAttested': False,
                'executionAttested': False, 'productionReady': False}


def validate_report(report, adapter_raw, base_raw, process_id, thread_id):
    """Replay caller-reported I/O. This does not prove any OS write occurred."""
    return _validate_report(report, adapter_raw, base_raw, process_id, thread_id, Transport, ())


def _validate_report(report, adapter_raw, base_raw, process_id, thread_id, transport_type, extra):
    try:
        need(type(report) is dict and type(report.get('calls')) is list and
             1 <= len(report['calls']) <= MAX_CALLS, 'REPORT_CALLS')
        t = transport_type(adapter_raw, base_raw, process_id, thread_id, *extra)
        for call in report['calls']:
            need(type(call) is dict, 'CALL')
            op = call.get('op')
            if op == 'feed':
                need(set(call) == {'op', 'side', 'rawHex'} and type(call['rawHex']) is str and
                     0 < len(call['rawHex']) <= 262144, 'FEED_CALL')
                raw = bytes.fromhex(call['rawHex'])
                need(raw.hex() == call['rawHex'], 'HEX_CANONICAL')
                t.feed(call['side'], raw)
            elif op == 'written':
                need(set(call) == {'op', 'side', 'count'}, 'WRITE_CALL')
                t.written(call['side'], call['count'])
            elif op == 'eof':
                need(set(call) == {'op', 'side'}, 'EOF_CALL')
                t.eof(call['side'])
            else:
                raise ValueError('CALL_OPERATION')
        return t.report()['complete'] and t.encode(t.report()) == t.encode(report)
    except (ValueError, TypeError, KeyError, RecursionError):
        return False


class WireTransport(Transport):
    """Final worker wire with real gate handshake; client discovery is upstream."""
    def __init__(self, adapter_raw, base_raw, process_id, thread_id, pid_namespace, mount_namespace):
        super().__init__(adapter_raw, base_raw, process_id, thread_id)
        need(type(pid_namespace) is str and type(mount_namespace) is str, 'NAMESPACE_TYPE')
        self.gate = self.adapter.base.Gate(pid_namespace, mount_namespace, 'trusted-cli-worker-boundary')
        self.pid_namespace = pid_namespace
        self.mount_namespace = mount_namespace
        self.wire_frames = []
        # Worker initialize is owned by this connection; no synthetic ready flags.
        self._enqueue('worker', self.encode(self.adapter.base.initialize_request()))

    def _enqueue(self, side, raw):
        if side == 'worker':
            need(not self.gate.pending, 'GATE_PENDING_REQUEST')
            self.gate.admit(self.adapter.parse(raw))
            raw = bytes(self.gate.pending)
            need(len(self.wire_frames) < 66, 'WIRE_FRAME_LIMIT')
            self.wire_frames.append(raw.hex())
        super()._enqueue(side, raw)

    def _frame(self, side, raw):
        if side == 'client':
            need(self.gate.initialized and self.gate.init_ok, 'WORKER_BOOTSTRAP_INCOMPLETE')
        else:
            self.gate.receive(self.adapter.parse(raw))
            if not self.gate.initialized:
                # Gate.receive already correlates id1 with a fully written init.
                need(self.gate.init_ok and self.gate.awaiting is None and
                     not self.gate.pending, 'WORKER_INITIALIZE_REPLY')
                self._enqueue('worker', self.encode({'method': 'initialized', 'params': {}}))
                return
        super()._frame(side, raw)

    def written(self, side, count):
        try:
            self._guard(side)
            need(type(count) is int and 0 < count <= len(self._pending[side]), 'WRITE_COUNT')
            if side == 'worker':
                need(bytes(self.gate.pending) == bytes(self._pending[side]), 'GATE_WIRE_DIVERGED')
                self.gate.written(count)
            super().written(side, count)
        except BaseException:
            self._fail()
            raise

    def _fail(self):
        super()._fail()
        if hasattr(self, 'gate'):
            self.gate.failed = True
            self.gate.pending.clear()
            self.gate.pending_frames.clear()

    def report(self):
        report = super().report()
        gate = self.gate
        ready = gate.initialized and gate.init_ok
        complete = (report['complete'] and ready and not gate.failed and gate.closed and
                    gate.exited and gate.awaiting is None and not gate.pending)
        report.update(profile='captured-worker-final-wire-accounting',
                      outerPidNamespace=self.pid_namespace, outerMountNamespace=self.mount_namespace,
                      wireFrames=list(self.wire_frames),
                      gate={'bootstrapComplete': ready, 'started': gate.started,
                            'exited': gate.exited, 'closed': gate.closed, 'failed': gate.failed,
                            'awaiting': list(gate.awaiting) if gate.awaiting is not None else None,
                            'notificationSeq': gate.notification_seq, 'identifier': gate.identifier},
                      complete=complete, writeAccountingComplete=complete,
                      bootstrapAttested=False, isolationAttested=False)
        return report


def validate_wire_report(report, adapter_raw, base_raw, process_id, thread_id, pid_namespace, mount_namespace):
    return _validate_report(report, adapter_raw, base_raw, process_id, thread_id,
                            WireTransport, (pid_namespace, mount_namespace))


def pump(transport, client_socket, worker_socket, timeout=5.0, cancelled=None):
    """Consume two caller-owned socket endpoints, then close both on every path.

    No connect, listen or process launch. Peers, isolation and remote cleanup
    remain the caller's responsibility. Cancellation is checked at most 50 ms
    apart while waiting; it must be a quick, nonblocking callable.
    """
    started = time.monotonic()
    endpoints = {'client': client_socket, 'worker': worker_socket}
    selector = None
    shutdown = {side: False for side in SIDES}
    error = None
    local_closed = True
    received = {side: 0 for side in SIDES}
    sent = {side: 0 for side in SIDES}
    observed_eof = {side: False for side in SIDES}
    try:
        need(isinstance(transport, WireTransport), 'WIRE_TRANSPORT_REQUIRED')
        need(not transport.failed and not transport.calls and transport.adapter.stage == 0 and
             not transport.gate.init_ok, 'FRESH_WIRE_TRANSPORT_REQUIRED')
        need(type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 180, 'PUMP_TIMEOUT')
        need(cancelled is None or callable(cancelled), 'PUMP_CANCELLATION')
        need(all(isinstance(endpoint, socket.socket) for endpoint in endpoints.values()) and
             client_socket.fileno() >= 0 and worker_socket.fileno() >= 0 and
             client_socket.fileno() != worker_socket.fileno(), 'PUMP_ENDPOINTS')
        deadline = started + timeout
        selector = selectors.DefaultSelector()
        for endpoint in endpoints.values():
            endpoint.setblocking(False)
        while True:
            need(not transport.failed, 'TRANSPORT_FAILED')
            need(not (cancelled is not None and cancelled()), 'PUMP_CANCELLED')
            need(time.monotonic() < deadline, 'PUMP_DEADLINE')
            for side, endpoint in endpoints.items():
                other = 'worker' if side == 'client' else 'client'
                # EOF closes only the opposite output, after all mapped bytes.
                if transport._eof[other] and not transport.pending(side) and not shutdown[side]:
                    endpoint.shutdown(socket.SHUT_WR)
                    shutdown[side] = True
                events = 0 if transport._eof[side] else selectors.EVENT_READ
                # The client's first frame may already be buffered in its socket.
                # Finish our independent worker handshake before consuming it.
                if side == 'client' and not transport.gate.initialized:
                    events = 0
                if transport.pending(side):
                    need(not shutdown[side], 'OUTPUT_AFTER_SHUTDOWN')
                    events |= selectors.EVENT_WRITE
                try:
                    selector.get_key(endpoint)
                    registered = True
                except KeyError:
                    registered = False
                if events:
                    if registered:
                        selector.modify(endpoint, events, side)
                    else:
                        selector.register(endpoint, events, side)
                elif registered:
                    selector.unregister(endpoint)
            if transport.report()['complete']:
                break
            ready = selector.select(min(0.05, max(0, deadline - time.monotonic())))
            need(not (cancelled is not None and cancelled()), 'PUMP_CANCELLED')
            need(time.monotonic() < deadline, 'PUMP_DEADLINE')
            for key, events in ready:
                side = key.data
                endpoint = key.fileobj
                if events & selectors.EVENT_READ:
                    try:
                        raw = endpoint.recv(65536)
                    except (BlockingIOError, InterruptedError):
                        raw = None
                    if raw is not None:
                        if raw:
                            received[side] += len(raw)
                            transport.feed(side, raw)
                        else:
                            observed_eof[side] = True
                            transport.eof(side)
                if events & selectors.EVENT_WRITE and transport.pending(side):
                    try:
                        count = endpoint.send(transport.pending(side)[:65536])
                    except (BlockingIOError, InterruptedError):
                        continue
                    sent[side] += count
                    transport.written(side, count)
    except BaseException as exc:
        error = str(exc) if isinstance(exc, ValueError) else type(exc).__name__
        transport.abort()
    finally:
        if selector is not None:
            try:
                selector.close()
            except BaseException:
                local_closed = False
        seen = set()
        for endpoint in endpoints.values():
            if id(endpoint) in seen:
                continue
            seen.add(id(endpoint))
            try:
                endpoint.close()
            except BaseException:
                local_closed = False
        if not local_closed:
            transport.abort()
            error = error or 'LOCAL_CLOSE_FAILED'
    protocol = transport.report()
    return {'version': 1, 'profile': 'captured-worker-socket-pump',
            'protocol': protocol, 'complete': protocol['complete'] and error is None and local_closed,
            'error': error, 'localSocketsClosed': local_closed,
            'socketIo': {'receivedBytes': received, 'sentBytes': sent, 'inputEof': observed_eof},
            'elapsedMs': round((time.monotonic() - started) * 1000, 3),
            'executionAttested': False, 'remoteCleanupAttested': False, 'productionReady': False}
