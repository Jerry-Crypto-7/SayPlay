"""One-shot authored client discovery joined to the pinned final worker wire.

The client chooses a routing handle; it never chooses a worker or permissions.
This fixture does not attest client provenance or filesystem metadata.
"""
import hashlib
import types

TRANSPORT_SHA = '1fd29febe98f57d42d9e49dece02745e8c5021842888400b2e9e00f03c5db657'
PLACEHOLDER = '1-00000000-0000-0000-0000-000000000000'
SKILLS = ('file:///work/.agents/skills', 'file:///work/exec-worker/.agents/skills')
GIT = ('file:///work/exec-worker/.git', 'file:///work/.git', 'file:///.git')


def need(value, reason):
    if not value:
        raise ValueError(reason)


def create(transport_raw, adapter_raw, base_raw, thread_id, pid_namespace, mount_namespace):
    """Create a fresh fixture connection with an externally supplied thread.

    No credentials, file lookup, process launch, or namespace attestation.
    The caller must explicitly choose this fixed-worker experimental profile.
    """
    need(type(transport_raw) is bytes and hashlib.sha256(transport_raw).hexdigest() ==
         TRANSPORT_SHA, 'TRANSPORT_SOURCE')
    wire = types.ModuleType('pinned_session_wire')
    exec(compile(transport_raw, '<pinned-session-wire>', 'exec'), wire.__dict__)

    class FixtureSessionTransport(wire.WireTransport):
        def __init__(self):
            self.bound_process_id = None
            self.bootstrap_step = 0
            self.bootstrap_reply_end = 0
            self.skills_seen = set()
            self.git_seen = set()
            super().__init__(adapter_raw, base_raw, PLACEHOLDER, thread_id,
                             pid_namespace, mount_namespace)

        def _frame(self, side, raw):
            if side != 'client' or self.bound_process_id is not None:
                return super()._frame(side, raw)
            need(self.gate.initialized and self.gate.init_ok, 'WORKER_BOOTSTRAP_INCOMPLETE')
            frame = self.adapter.parse(raw)
            need(type(frame) is dict, 'FRAME_SHAPE')
            step = self.bootstrap_step
            # Git discovery is pipelined by the pinned client. This fixture
            # requires previous replies written in other phases, including start.
            if step not in (7, 8):
                need(self.writes['client'] >= self.bootstrap_reply_end, 'BOOTSTRAP_REPLY_NOT_WRITTEN')
            if step == 9:
                params = frame.get('params')
                need(type(params) is dict, 'START_CONTRACT')
                candidate = self.adapter.__class__(base_raw, params.get('processId'), thread_id)
                # Validate *every* field before installing the selected handle.
                # This candidate has no transport and cannot queue worker bytes.
                candidate.start(raw)
                self.adapter = self.adapter.__class__(base_raw, candidate.process_id, thread_id)
                super()._frame(side, raw)
                self.bound_process_id = candidate.process_id
                return
            response = self._bootstrap(frame, step)
            self.bootstrap_step += 1
            if response is not None:
                self._enqueue('client', self.encode(response))
                self.bootstrap_reply_end = self.enqueued['client']

        def _bootstrap(self, frame, step):
            if step == 0:
                expected = {'id': 1, 'method': 'initialize', 'params': {
                    'clientName': 'codex-environment', 'resumeSessionId': None}}
                response = {'id': 1, 'result': {'sessionId': 'capture-fixture'}}
            elif step == 1:
                expected = {'method': 'initialized', 'params': {}}
                response = None
            elif step == 2:
                expected = {'id': 2, 'method': 'environment/info', 'params': None}
                response = {'id': 2, 'result': {'shell': {'name': 'sh', 'path': '/bin/sh'},
                    'cwd': 'file:///work', 'capabilities': {'networkProxyLaunch': True}}}
            else:
                params = frame.get('params')
                need(type(params) is dict and type(params.get('path')) is str, 'DISCOVERY_PATH')
                path = params['path']
                identifier = step
                if step in (3, 4):
                    need(path in SKILLS and path not in self.skills_seen, 'SKILLS_PATH')
                    self.skills_seen.add(path)
                    response = {'id': identifier, 'error': {'code': -32004,
                        'message': 'Authored capture fixture: path absent'}}
                elif step == 5:
                    need(path == 'file:///work/exec-worker', 'CWD_PATH')
                    response = {'id': identifier, 'result': {'isDirectory': True, 'isFile': False,
                        'isSymlink': False, 'size': 0, 'createdAtMs': 0, 'modifiedAtMs': 0}}
                else:
                    need(step in (6, 7, 8) and path in GIT and path not in self.git_seen, 'GIT_PATH')
                    self.git_seen.add(path)
                    response = {'id': identifier, 'error': {'code': -32004,
                        'message': 'Authored capture fixture: git marker absent'}}
                expected = {'id': identifier, 'method': 'fs/getMetadata',
                            'params': {'path': path, 'sandbox': None}}
            # Canonical JSON comparison also distinguishes bool/float from int.
            need(self.encode(frame) == self.encode(expected), 'CLIENT_BOOTSTRAP_CONTRACT')
            return response

        def report(self):
            report = super().report()
            # The construction placeholder is internal and never an attested ID.
            if self.bound_process_id is None:
                report['protocol']['processId'] = None
            complete = report['complete'] and self.bootstrap_step == 9 and self.bound_process_id is not None
            report.update(profile='authored-captured-session-final-wire',
                          transportSha256=TRANSPORT_SHA, expectedThreadId=thread_id,
                          boundProcessId=self.bound_process_id, bootstrapStep=self.bootstrap_step,
                          clientBootstrapComplete=(self.bootstrap_step == 9 and not self.failed and
                                                   self.writes['client'] >= self.bootstrap_reply_end),
                          bootstrapResponses='authored-fixture', metadataAttested=False,
                          routingIdentityAttested=False, clientProvenanceAttested=False,
                          complete=complete, writeAccountingComplete=complete)
            return report

    result = FixtureSessionTransport()
    # Keep the exact pinned pump/type pair together; independently loading the
    # module would give a different class identity for its isinstance guard.
    result._session_pump = wire.pump
    result._session_replay = wire._validate_report
    return result


def pump(transport, client_socket, worker_socket, timeout=5.0, cancelled=None):
    """Same consumed socket ownership and deadline contract as the pinned pump."""
    return transport._session_pump(transport, client_socket, worker_socket, timeout, cancelled)


def validate_report(report, transport_raw, adapter_raw, base_raw, thread_id, pid_namespace, mount_namespace):
    """Replay a fixture transcript; the client handle is data, not authorization.

    Thread and namespaces are supplied independently. A self-consistent replay
    does not prove peer identity, metadata truth, execution, or OS delivery.
    """
    try:
        fresh = create(transport_raw, adapter_raw, base_raw, thread_id, pid_namespace, mount_namespace)
        return fresh._session_replay(report, adapter_raw, base_raw, None, thread_id,
                                    lambda *_: fresh, ())
    except (ValueError, TypeError, KeyError, RecursionError):
        return False
