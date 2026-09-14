"""Offline, one-shot start mapping. No transport, launcher, or OS attestation."""
import base64
import hashlib
import json
import re
import types

BASE_SHA = '2311f43aba1e79460391e720f113578db059fba45819266e104b559e12278d35'
CAPTURE_SHA = '6e15f67afd9c7d2441bb992e566fa8d8a2b4787d0a3a3e8c258d0861b8c9d062'
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'


def need(value, reason):
    if not value:
        raise ValueError(reason)


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode() + b'\n'


def client_request(process_id, thread_id):
    return {'id': 9, 'method': 'process/start', 'params': {
        'processId': process_id,
        'argv': ['/bin/sh', '-c', '/usr/bin/python3 -I -S /usr/bin/trusted-cli-worker-probe.py'],
        'cwd': 'file:///work/exec-worker',
        'envPolicy': {'inherit': 'all', 'ignoreDefaultExcludes': True,
            'exclude': ['CODEX_PERMISSION_PROFILE'], 'set': {}, 'includeOnly': []},
        'env': {'NO_COLOR': '1', 'COLORTERM': '', 'CODEX_CI': '1', 'TERM': 'dumb',
            'CODEX_SANDBOX_NETWORK_DISABLED': '1', 'GH_PAGER': 'cat', 'LC_ALL': 'C.UTF-8',
            'PAGER': 'cat', 'LC_CTYPE': 'C.UTF-8', 'CODEX_THREAD_ID': thread_id, 'GIT_PAGER': 'cat'},
        'tty': False, 'pipeStdin': False, 'arg0': None,
        'sandbox': {'permissions': {'type': 'managed', 'file_system': {'type': 'restricted',
            'entries': [{'path': {'type': 'special', 'value': {'kind': 'root'}}, 'access': 'read'}]},
            'network': 'restricted'}, 'cwd': 'file:///work/exec-worker',
            'workspaceRoots': ['file:///work/exec-worker'], 'windowsSandboxLevel': 'disabled',
            'windowsSandboxPrivateDesktop': True, 'useLegacyLandlock': False},
        'enforceManagedNetwork': False, 'managedNetwork': None}}


class StartAdapter:
    def __init__(self, base_raw, process_id, thread_id):
        # Identities come from the trusted controller, never learned from this frame.
        need(type(process_id) is str and len(process_id) <= 47 and
             re.fullmatch(r'[1-9][0-9]{0,9}-' + UUID, process_id) is not None and
             int(process_id.split('-')[0]) <= 2147483647, 'PROCESS_ID')
        need(type(thread_id) is str and re.fullmatch(UUID, thread_id) is not None, 'THREAD_ID')
        need(type(base_raw) is bytes and hashlib.sha256(base_raw).hexdigest() == BASE_SHA, 'BASE_SOURCE')
        self.base = types.ModuleType('captured_start_fixed_base')
        exec(compile(base_raw, '<pinned-worker-gate>', 'exec'), self.base.__dict__)
        self.process_id = process_id
        self.thread_id = thread_id
        self.events = []
        self.stage = 0
        self.failed = False

    def parse(self, raw):
        need(type(raw) is bytes and 0 < len(raw) <= 131072 and
             raw.endswith(b'\n') and b'\n' not in raw[:-1], 'FRAME_BOUND')
        return self.base.strict_json(raw)

    def start(self, raw):
        try:
            need(not self.failed and self.stage == 0, 'START_ORDER')
            frame = self.parse(raw)
            need(encode(frame) == encode(client_request(self.process_id, self.thread_id)), 'START_CONTRACT')
            # This is an explicit fixed-worker profile, not preservation of the
            # caller's readonly sandbox: it grants the worker its dedicated cwd.
            # No client argv, environment, sandbox or identity reaches the output.
            mapped = self.base.trusted_cli_start_request()
            result = encode(mapped)
            self.events.append({'kind': 'start', 'inputHex': raw.hex(), 'outputHex': result.hex()})
            self.stage = 1
            return result
        except BaseException:
            self.failed = True
            raise

    def reply(self, raw):
        try:
            need(not self.failed and self.stage == 1, 'REPLY_ORDER')
            frame = self.parse(raw)
            need(encode(frame) == encode({'id': 2, 'result': {'processId': 'fixed-worker'}}), 'START_REPLY')
            result = encode({'id': 9, 'result': {'processId': self.process_id}})
            self.events.append({'kind': 'reply', 'inputHex': raw.hex(), 'outputHex': result.hex()})
            self.stage = 2
            return result
        except BaseException:
            self.failed = True
            raise

    def report(self):
        return {'version': 1, 'profile': 'offline-captured-start-to-fixed-worker',
            'baseSha256': BASE_SHA, 'referenceCaptureSha256': CAPTURE_SHA,
            'processId': self.process_id, 'threadId': self.thread_id,
            'events': [dict(event) for event in self.events],
            'complete': self.stage == 2 and not self.failed, 'failed': self.failed,
            'deliveryAttested': False, 'executionAttested': False, 'productionReady': False}


def validate_report(report, base_raw, process_id, thread_id):
    """Replay with identities supplied separately; a report cannot authorize itself."""
    try:
        need(type(report) is dict and type(report.get('events')) is list and len(report['events']) == 2, 'REPORT')
        adapter = StartAdapter(base_raw, process_id, thread_id)
        for event, method, kind in zip(report['events'], (adapter.start, adapter.reply), ('start', 'reply')):
            need(type(event) is dict and set(event) == {'kind', 'inputHex', 'outputHex'} and event['kind'] == kind, 'EVENT')
            need(all(type(event[key]) is str and 0 < len(event[key]) <= 262144
                     for key in ('inputHex', 'outputHex')), 'EVENT_BOUND')
            raw = bytes.fromhex(event['inputHex'])
            need(raw.hex() == event['inputHex'] and method(raw).hex() == event['outputHex'], 'EVENT_BYTES')
        return encode(adapter.report()) == encode(report)
    except (ValueError, TypeError, KeyError, RecursionError):
        return False


class LifecycleAdapter(StartAdapter):
    """Bounded, lossless notification profile; no read recovery or transport."""
    MAX_EVENTS = 64
    MAX_BYTES = 1048576

    def __init__(self, base_raw, process_id, thread_id):
        super().__init__(base_raw, process_id, thread_id)
        self.seq = 0
        self.exited = False
        self.closed = False

    def reply(self, raw):
        try:
            need(type(raw) is bytes, 'FRAME_BOUND')
            result = encode({'id': 9, 'result': {'processId': self.process_id}})
            total = sum((len(e['inputHex']) + len(e['outputHex'])) // 2 for e in self.events)
            need(len(self.events) < self.MAX_EVENTS and
                 total + len(raw) + len(result) <= self.MAX_BYTES, 'REPLY_LIMIT')
            return super().reply(raw)
        except BaseException:
            self.failed = True
            raise

    def notification(self, raw):
        try:
            # A fast worker may notify before the start RPC reply arrives.
            need(not self.failed and self.stage in (1, 2) and not self.closed, 'NOTIFICATION_ORDER')
            need(len(self.events) < self.MAX_EVENTS - (self.stage == 1), 'EVENT_LIMIT')
            frame = self.parse(raw)
            need(type(frame) is dict and set(frame) == {'method', 'params'}, 'NOTIFICATION_SHAPE')
            p = frame['params']
            need(type(p) is dict and p.get('processId') == 'fixed-worker' and
                 type(p.get('seq')) is int and p['seq'] == self.seq + 1, 'NOTIFICATION_IDENTITY')
            method = frame['method']
            if method == 'process/output':
                self.base.output_chunk({key: value for key, value in p.items() if key != 'processId'})
                need(p['stream'] in ('stdout', 'stderr'), 'NON_TTY_STREAM')
            elif method == 'process/exited':
                need(not self.exited and set(p) == {'processId', 'seq', 'exitCode', 'sandboxDenied'} and
                     type(p['exitCode']) is int and -2147483648 <= p['exitCode'] <= 2147483647 and
                     type(p['sandboxDenied']) is bool, 'EXIT_SHAPE')
            elif method == 'process/closed':
                need(self.exited and set(p) == {'processId', 'seq'}, 'CLOSED_ORDER')
            else:
                raise ValueError('NOTIFICATION_METHOD')
            result = encode({'method': method, 'params': {**p, 'processId': self.process_id}})
            # Reserve room for a late start reply; retain exact bytes in both directions.
            total = sum((len(e['inputHex']) + len(e['outputHex'])) // 2 for e in self.events)
            need(total + len(raw) + len(result) <= self.MAX_BYTES - (256 if self.stage == 1 else 0), 'BYTE_LIMIT')
            self.events.append({'kind': 'notification', 'inputHex': raw.hex(), 'outputHex': result.hex()})
            self.seq = p['seq']
            self.exited = self.exited or method == 'process/exited'
            self.closed = method == 'process/closed'
            return result
        except BaseException:
            self.failed = True
            raise

    def report(self):
        report = super().report()
        report.update(version=2, profile='offline-captured-worker-notifications',
                      complete=self.stage == 2 and self.closed and not self.failed,
                      notificationSeq=self.seq, exited=self.exited, closed=self.closed)
        return report


def validate_lifecycle_report(report, base_raw, process_id, thread_id):
    return _validate_stream_report(report, base_raw, process_id, thread_id, LifecycleAdapter)


def _validate_stream_report(report, base_raw, process_id, thread_id, adapter_type):
    try:
        need(type(report) is dict and type(report.get('events')) is list and
             4 <= len(report['events']) <= LifecycleAdapter.MAX_EVENTS, 'REPORT')
        a = adapter_type(base_raw, process_id, thread_id)
        methods = {'start': a.start, 'reply': a.reply, 'notification': a.notification}
        if isinstance(a, ReadAdapter):
            methods.update(read=a.read, read_reply=a.read_reply)
        for event in report['events']:
            need(type(event) is dict and set(event) == {'kind', 'inputHex', 'outputHex'}, 'EVENT')
            need(type(event['kind']) is str and event['kind'] in methods, 'EVENT_KIND')
            need(all(type(event[key]) is str and 0 < len(event[key]) <= 262144
                     for key in ('inputHex', 'outputHex')), 'EVENT_BOUND')
            raw = bytes.fromhex(event['inputHex'])
            need(raw.hex() == event['inputHex'] and methods[event['kind']](raw).hex() == event['outputHex'], 'EVENT_BYTES')
        return a.report()['complete'] and encode(a.report()) == encode(report)
    except (ValueError, TypeError, KeyError, RecursionError):
        return False


class ReadAdapter(LifecycleAdapter):
    """Serial fixed-budget reads; snapshots do not attest notification delivery."""
    def __init__(self, base_raw, process_id, thread_id):
        super().__init__(base_raw, process_id, thread_id)
        self.read_count = 0
        self.pending_read = None

    def record_read(self, kind, raw, mapped):
        result = encode(mapped)
        total = sum((len(e['inputHex']) + len(e['outputHex'])) // 2 for e in self.events)
        need(len(self.events) < self.MAX_EVENTS and
             total + len(raw) + len(result) <= self.MAX_BYTES, 'READ_LIMIT')
        self.events.append({'kind': kind, 'inputHex': raw.hex(), 'outputHex': result.hex()})
        return result

    def read(self, raw):
        try:
            need(not self.failed and self.stage == 2 and not self.closed and
                 self.pending_read is None, 'READ_ORDER')
            frame = self.parse(raw)
            need(type(frame) is dict and set(frame) == {'id', 'method', 'params'} and
                 type(frame['params']) is dict, 'READ_SHAPE')
            client_id = 10 + self.read_count
            worker_id = 3 + self.read_count
            after = frame['params'].get('afterSeq')
            need(after is None or type(after) is int and 0 <= after < 2**64, 'READ_CURSOR')
            mapped = self.base.read_request(worker_id, after)
            expected = self.base.read_request(client_id, after)
            expected['params']['processId'] = self.process_id
            need(encode(frame) == encode(expected), 'READ_CONTRACT')
            result = self.record_read('read', raw, mapped)
            self.pending_read = {'clientId': client_id, 'workerId': worker_id, 'afterSeq': after}
            self.read_count += 1
            return result
        except BaseException:
            self.failed = True
            raise

    def read_reply(self, raw):
        try:
            need(not self.failed and self.pending_read is not None, 'READ_REPLY_ORDER')
            frame = self.parse(raw)
            need(type(frame) is dict and set(frame) == {'id', 'result'} and
                 type(frame['id']) is int and frame['id'] == self.pending_read['workerId'], 'READ_REPLY_ID')
            value = frame['result']
            need(type(value) is dict and set(value) == {'chunks', 'nextSeq', 'exited',
                 'exitCode', 'closed', 'failure', 'sandboxDenied'}, 'READ_RESULT')
            need(type(value['chunks']) is list and len(value['chunks']) <= 64 and
                 type(value['nextSeq']) is int and 1 <= value['nextSeq'] < 2**64 and
                 all(type(value[k]) is bool for k in ('exited', 'closed', 'sandboxDenied')) and
                 value['failure'] is None, 'READ_RESULT_FIELDS')
            code = value['exitCode']
            need((value['exited'] and type(code) is int and -2147483648 <= code <= 2147483647 or
                  not value['exited'] and code is None) and
                 (not value['closed'] or value['exited']) and
                 (not value['sandboxDenied'] or value['exited']), 'READ_TERMINAL')
            previous = self.pending_read['afterSeq'] or 0
            total = 0
            for chunk in value['chunks']:
                self.base.output_chunk(chunk)
                need(previous < chunk['seq'] < 2**64, 'READ_CHUNK_ORDER')
                previous = chunk['seq']
                total += len(base64.b64decode(chunk['chunk'], validate=True))
            need(total <= 65536 and (not value['chunks'] or value['nextSeq'] == previous + 1), 'READ_CHUNK_BOUND')
            # Empty reads may report a cursor older than the requested afterSeq.
            # Snapshot state can precede notifications already seen on this pipe.
            result = self.record_read('read_reply', raw, {'id': self.pending_read['clientId'], 'result': value})
            self.pending_read = None
            return result
        except BaseException:
            self.failed = True
            raise

    def report(self):
        report = super().report()
        report.update(version=3, profile='offline-captured-worker-reads', readCount=self.read_count,
                      pendingRead=dict(self.pending_read) if self.pending_read is not None else None,
                      complete=report['complete'] and self.pending_read is None)
        return report


def validate_read_report(report, base_raw, process_id, thread_id):
    return _validate_stream_report(report, base_raw, process_id, thread_id, ReadAdapter)
