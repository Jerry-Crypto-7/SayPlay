"""Offline contract for a stock appserver with an authored Responses peer.

No launcher: the future Linux parent must provide isolation and bounded IO.
This module never executes tool argv or accesses credentials.
"""
import hashlib
import json

MODEL = 'gpt-5.6-sol'
PROVIDER = 'capture-fixture'
HOME = '/work/capture-appserver-home'
BASE_URL = 'http://127.0.0.1:31317/v1'
CALL_ID = 'capture_tool_call'
COMMAND = '/usr/bin/python3 -I -S /usr/bin/trusted-cli-worker-probe.py'
MAX_FRAME = 131072
MAX_TOTAL = 2 * 1024 * 1024


def need(value, reason):
    if not value:
        raise ValueError(reason)


def encode(value):
    return json.dumps(value, separators=(',', ':'), sort_keys=True,
                      allow_nan=False).encode()


def pairs(items):
    result = {}
    for key, value in items:
        need(key not in result, 'DUPLICATE_KEY')
        result[key] = value
    return result


def constant(_):
    raise ValueError('NONFINITE_JSON')


def decode(raw):
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                       parse_constant=constant)
    # Also rejects exponent overflow (1e999), which parse_constant does not see.
    encode(value)
    return value


def config():
    flags = ['apps', 'multi_agent', 'multi_agent_v2', 'image_generation', 'goals',
             'memories', 'plugins', 'code_mode', 'code_mode_only', 'deferred_executor',
             'token_budget', 'current_time_reminder', 'skill_search', 'shell_snapshot']
    result = {'features.' + name: False for name in flags}
    result.update({'features.shell_tool': True, 'features.unified_exec': True,
        'model_reasoning_effort': 'low',
        'agents.enabled': False, 'tools.experimental_request_user_input.enabled': False,
        'orchestrator.skills.enabled': False, 'orchestrator.mcp.enabled': False,
        'skills.include_instructions': False, 'web_search': 'disabled',
        'project_doc_max_bytes': 0, 'project_root_markers': [],
        'model_catalog_json': '/usr/bin/text-model-catalog.json',
        'model_provider': PROVIDER,
        'model_providers.' + PROVIDER: {'name': 'Authored capture fixture',
            'base_url': BASE_URL, 'wire_api': 'responses', 'requires_openai_auth': False,
            'request_max_retries': 0, 'stream_max_retries': 0,
            'supports_websockets': False}})
    return result


def thread_request():
    return {'id': 2, 'method': 'thread/start', 'params': {
        'model': MODEL, 'modelProvider': PROVIDER, 'allowProviderModelFallback': False,
        'cwd': '/work', 'approvalPolicy': 'never', 'sandbox': 'read-only',
        'ephemeral': True, 'dynamicTools': [], 'selectedCapabilityRoots': [],
        'runtimeWorkspaceRoots': ['/work/exec-worker'],
        'environments': [{'environmentId': 'fixed-worker', 'cwd': '/work/exec-worker',
                          'runtimeWorkspaceRoots': ['/work/exec-worker']}],
        'config': config()}}


def home_files():
    """Fixed bytes for a future parent to create exclusively in a new home."""
    def toml(value):
        if type(value) is dict:
            return '{' + ','.join(json.dumps(k) + '=' + toml(v) for k, v in value.items()) + '}'
        return json.dumps(value, allow_nan=False)
    values = {'model': MODEL, 'approval_policy': 'never', 'sandbox_mode': 'read-only', **config()}
    configuration = ''.join(k + '=' + toml(v) + '\n' for k, v in values.items()).encode()
    environments = b'''include_local = false
default = "fixed-worker"
[[environments]]
id = "fixed-worker"
program = "/usr/bin/python3"
args = ["-I", "-S", "/usr/bin/exec-request-capture.py", "--stdio-fixture"]
cwd = "/work"
'''
    return {'config.toml': configuration, 'environments.toml': environments}


def tool_arguments():
    return {'cmd': COMMAND, 'environment_id': 'fixed-worker',
            'workdir': '/work/exec-worker', 'login': False, 'yield_time_ms': 500}


def sse(item, identifier):
    events = [
        {'type': 'response.created', 'response': {'id': identifier}},
        {'type': 'response.output_item.done', 'item': item},
        {'type': 'response.completed', 'response': {'id': identifier, 'usage': {
            'input_tokens': 0, 'input_tokens_details': None, 'output_tokens': 0,
            'output_tokens_details': None, 'total_tokens': 0}}},
    ]
    return b''.join(b'event: ' + e['type'].encode() + b'\ndata: ' + encode(e) + b'\n\n'
                    for e in events)


def request_tools(request):
    # Pinned client core/client.rs moves tools into a developer AdditionalTools
    # input item for catalogs with use_responses_lite=true (observed stock wire).
    additional = [item for item in request['input'] if type(item) is dict
                  and item.get('type') == 'additional_tools']
    if additional:
        need('tools' not in request and len(additional) == 1
             and additional[0].get('role') == 'developer', 'AMBIGUOUS_TOOL_CATALOG')
        return additional[0].get('tools')
    return request.get('tools')


class ResponsesPeer:
    """Two authored replies. HTTP framing, deadlines and isolation belong to parent.

    Call prepare, write the returned bytes, then delivered after full flush.
    """
    def __init__(self):
        self.step = 0
        self.pending = None
        self.failed = False
        self.events = []

    def prepare(self, method, path, headers, body):
        try:
            need(not self.failed and self.pending is None and self.step < 2, 'PEER_CLOSED')
            need(method == 'POST' and path == '/v1/responses', 'FIXED_RESPONSES_ROUTE')
            need(type(headers) is list and len(headers) <= 64 and type(body) is bytes
                 and 0 < len(body) <= MAX_TOTAL, 'HTTP_BOUND')
            normalized = {}
            for key, value in headers:
                need(type(key) is str and type(value) is str and len(key) + len(value) <= 8192,
                     'HEADER_TYPE')
                key = key.lower()
                need(key not in normalized, 'DUPLICATE_HEADER')
                normalized[key] = value
            need(not ({'authorization', 'proxy-authorization', 'cookie', 'x-api-key',
                       'transfer-encoding', 'content-encoding', 'upgrade'} & normalized.keys()),
                 'UNSUPPORTED_HEADERS')
            need(normalized.get('content-type', '').split(';')[0].strip() == 'application/json'
                 and normalized.get('content-length') == str(len(body)), 'HTTP_FRAMING')
            self.events.append({'requestRawHex': body.hex(),
                'requestSha256': hashlib.sha256(body).hexdigest(),
                'responseRawHex': None, 'delivered': False})
            request = decode(body)
            need(type(request) is dict and request.get('model') == MODEL
                 and request.get('stream') is True and type(request.get('input')) is list,
                 'RESPONSES_REQUEST')
            outputs = [item for item in request['input'] if type(item) is dict
                       and item.get('type') == 'function_call_output']
            if self.step == 0:
                need(not outputs, 'EARLY_TOOL_OUTPUT')
                tools = request_tools(request)
                need(type(tools) is list and sum(type(t) is dict and t.get('type') == 'function'
                     and t.get('name') == 'exec_command' for t in tools) == 1, 'EXEC_TOOL_REQUIRED')
                item = {'type': 'function_call', 'call_id': CALL_ID, 'name': 'exec_command',
                        'arguments': encode(tool_arguments()).decode()}
            else:
                need(len(outputs) == 1 and outputs[0].get('call_id') == CALL_ID
                     and 'output' in outputs[0], 'MATCHING_TOOL_OUTPUT_REQUIRED')
                item = {'type': 'message', 'role': 'assistant', 'id': 'capture-final',
                        'content': [{'type': 'output_text', 'text': 'Capture fixture finished.'}]}
            response = sse(item, 'capture-response-' + str(self.step + 1))
            self.events[-1]['responseRawHex'] = response.hex()
            self.pending = response
            return response
        except (ValueError, TypeError, KeyError, RecursionError):
            self.failed = True
            raise

    def delivered(self, count):
        try:
            need(not self.failed and self.pending is not None and type(count) is int
                 and count == len(self.pending), 'FULL_RESPONSE_DELIVERY_REQUIRED')
            self.events[-1]['delivered'] = True
            self.pending = None
            self.step += 1
        except (ValueError, TypeError):
            self.failed = True
            raise

    def report(self):
        return {'kind': 'authored-responses-peer', 'events': self.events,
            'responsesDelivered': self.step, 'complete': self.step == 2 and not self.failed,
            'failed': self.failed, 'inferenceAttested': False, 'productionReady': False}


class Controller:
    """One initialize/thread/start/turn/start sequence, with write accounting."""
    def __init__(self):
        self.pending = bytearray()
        self.frames = []
        self.delivered = set()
        self.expected = 1
        self.thread = None
        self.turn = None
        self.completed = False
        self.failed = False
        self.events = []
        self.total = 0
        self.queue({'id': 1, 'method': 'initialize', 'params': {
            'clientInfo': {'name': 'reality_compiler_capture_fixture', 'version': '1'},
            'capabilities': {'experimentalApi': True}}})

    def record(self, direction, raw):
        self.total += len(raw)
        need(self.total <= MAX_TOTAL, 'CONTROLLER_BYTE_BOUND')
        self.events.append({'direction': direction, 'rawHex': raw.hex()})

    def queue(self, frame):
        raw = encode(frame) + b'\n'
        self.record('queued', raw)
        self.pending.extend(raw)
        self.frames.append([len(raw), frame.get('id')])

    def written(self, count):
        try:
            need(not self.failed and type(count) is int and 0 < count <= len(self.pending),
                 'INVALID_WRITE')
            self.record('written', bytes(self.pending[:count]))
            del self.pending[:count]
            while count:
                take = min(count, self.frames[0][0])
                self.frames[0][0] -= take
                count -= take
                if self.frames[0][0] == 0:
                    _, identifier = self.frames.pop(0)
                    self.delivered.add(identifier)
        except (ValueError, TypeError, KeyError, RecursionError):
            self.failed = True
            raise

    def receive(self, raw):
        try:
            need(not self.failed and not self.completed, 'CONTROLLER_CLOSED')
            need(type(raw) is bytes and 0 < len(raw) <= MAX_FRAME
                 and raw.endswith(b'\n') and b'\n' not in raw[:-1], 'FRAME_BOUND')
            self.record('received', raw)
            frame = decode(raw)
            need(type(frame) is dict, 'FRAME_OBJECT')
            if 'method' in frame:
                # Never answer approvals, tool requests or any server-initiated RPC.
                need('id' not in frame and set(frame) <= {'method', 'params', 'emittedAtMs'}
                     and type(frame.get('params')) is dict, 'NOTIFICATION_REQUIRED')
                need(1 in self.delivered and self.expected > 1, 'EARLY_NOTIFICATION')
                params = frame['params']
                if frame['method'] == 'turn/completed':
                    need(self.expected == 4 and params.get('threadId') == self.thread,
                         'TURN_ORDER')
                    turn = params.get('turn')
                    need(type(turn) is dict and turn.get('id') == self.turn
                         and turn.get('status') == 'completed' and turn.get('error') is None,
                         'TURN_COMPLETION')
                    self.completed = True
                # Other notifications are bounded diagnostics, never completion evidence.
                return
            need(set(frame) == {'id', 'result'} and type(frame['id']) is int
                 and frame['id'] == self.expected and frame['id'] in self.delivered
                 and type(frame['result']) is dict, 'RESPONSE_ORDER')
            result = frame['result']
            if self.expected == 1:
                need(result.get('codexHome') == HOME and result.get('platformFamily') == 'unix'
                     and result.get('platformOs') == 'linux', 'CLIENT_IDENTITY')
                self.queue({'method': 'initialized', 'params': {}})
                self.queue(thread_request())
            elif self.expected == 2:
                thread = result.get('thread')
                need(result.get('model') == MODEL and result.get('modelProvider') == PROVIDER
                     and result.get('approvalPolicy') == 'never'
                     and result.get('runtimeWorkspaceRoots') == ['/work/exec-worker']
                     and result.get('sandbox') == {'type': 'readOnly', 'networkAccess': False}
                     and type(result['sandbox'].get('networkAccess')) is bool
                     and type(thread) is dict and thread.get('ephemeral') is True
                     and 'path' in thread and thread['path'] is None
                     and type(thread.get('id')) is str and 0 < len(thread['id']) <= 256,
                     'THREAD_PROFILE')
                self.thread = thread['id']
                self.queue({'id': 3, 'method': 'turn/start', 'params': {
                    'threadId': self.thread, 'input': [{'type': 'text',
                        'text': 'Run the fixed capture fixture command once.', 'text_elements': []}]}})
            elif self.expected == 3:
                turn = result.get('turn')
                need(type(turn) is dict and type(turn.get('id')) is str
                     and 0 < len(turn['id']) <= 256 and turn.get('status') == 'inProgress',
                     'TURN_START')
                self.turn = turn['id']
            else:
                raise ValueError('EXTRA_RESPONSE')
            self.expected += 1
        except (ValueError, TypeError, KeyError, RecursionError):
            self.failed = True
            raise

    def report(self):
        return {'kind': 'authored-responses-tool-controller', 'events': self.events,
            'turnCompleted': self.completed and not self.failed, 'failed': self.failed,
            'clientProvenance': 'not-attested', 'executionAttested': False,
            'inferenceAttested': False, 'productionReady': False}
