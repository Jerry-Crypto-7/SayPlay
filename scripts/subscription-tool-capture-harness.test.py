"""Authored appserver/provider conversations; no stock client is executed."""
import copy
import importlib.util
import json
from pathlib import Path
import tomllib

import pytest

PATH = Path(__file__).with_name('subscription-tool-capture-harness.py')
spec = importlib.util.spec_from_file_location('tool_capture_test', PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def flush(controller):
    raw = bytes(controller.pending)
    if raw:
        controller.written(len(raw))
    return [json.loads(line) for line in raw.splitlines()]


def reply(controller, identifier, result):
    controller.receive(m.encode({'id': identifier, 'result': result}) + b'\n')


INIT = {'codexHome': m.HOME, 'platformFamily': 'unix', 'platformOs': 'linux'}
THREAD = {'model': m.MODEL, 'modelProvider': m.PROVIDER, 'approvalPolicy': 'never',
    'runtimeWorkspaceRoots': ['/work/exec-worker'],
    'sandbox': {'type': 'readOnly', 'networkAccess': False},
    'thread': {'id': 'fixture-thread', 'ephemeral': True, 'path': None}}


def active_controller():
    c = m.Controller()
    flush(c)
    reply(c, 1, INIT)
    flush(c)
    reply(c, 2, THREAD)
    flush(c)
    reply(c, 3, {'turn': {'id': 'fixture-turn', 'status': 'inProgress'}})
    return c


def request(output=False):
    return {'model': m.MODEL, 'stream': True,
        'tools': [{'type': 'function', 'name': 'exec_command'}],
        'input': ([{'type': 'function_call_output', 'call_id': m.CALL_ID,
                   'output': 'Authored capture refusal'}] if output else [])}


def prepare(peer, value):
    raw = m.encode(value)
    return peer.prepare('POST', '/v1/responses', [
        ('Content-Type', 'application/json'), ('Content-Length', str(len(raw)))], raw)


def events(raw):
    result = []
    for block in raw.split(b'\n\n')[:-1]:
        event, data = block.split(b'\n')
        value = json.loads(data.removeprefix(b'data: '))
        assert event == b'event: ' + value['type'].encode()
        result.append(value)
    return result


def test_authored_two_response_conversation_and_turn_completion():
    c = active_controller()
    peer = m.ResponsesPeer()
    raw = prepare(peer, request())
    values = events(raw)
    assert [v['type'] for v in values] == [
        'response.created', 'response.output_item.done', 'response.completed']
    item = values[1]['item']
    assert item['type'] == 'function_call' and item['name'] == 'exec_command'
    assert json.loads(item['arguments']) == m.tool_arguments()
    assert peer.step == 0
    peer.delivered(len(raw))
    final = prepare(peer, request(True))
    assert events(final)[1]['item']['type'] == 'message'
    peer.delivered(len(final))
    c.receive(m.encode({'method': 'turn/completed', 'params': {'threadId': 'fixture-thread',
        'turn': {'id': 'fixture-turn', 'status': 'completed', 'error': None}}}) + b'\n')
    assert peer.report()['complete'] and c.report()['turnCompleted']
    assert c.report()['executionAttested'] is False
    assert peer.report()['inferenceAttested'] is False
    assert c.report()['clientProvenance'] == 'not-attested'
    assert not c.pending


def test_home_config_selects_only_capture_endpoint_and_auth_free_http_provider():
    files = m.home_files()
    config = tomllib.loads(files['config.toml'].decode())
    envs = tomllib.loads(files['environments.toml'].decode())
    provider = config['model_providers'][m.PROVIDER]
    assert provider['base_url'] == m.BASE_URL
    assert provider['requires_openai_auth'] is False
    assert provider['supports_websockets'] is False
    assert provider['request_max_retries'] == provider['stream_max_retries'] == 0
    assert 'env_key' not in provider
    assert config['features']['shell_tool'] is True and config['features']['unified_exec'] is True
    assert config['features']['apps'] is False and config['features']['shell_snapshot'] is False
    assert envs['include_local'] is False and len(envs['environments']) == 1
    assert envs['environments'][0]['args'] == [
        '-I', '-S', '/usr/bin/exec-request-capture.py', '--stdio-fixture']
    assert m.thread_request()['params']['modelProvider'] == m.PROVIDER


def test_partial_write_cannot_admit_early_reply():
    c = m.Controller()
    c.written(len(c.pending) - 1)
    with pytest.raises(ValueError, match='RESPONSE_ORDER'):
        reply(c, 1, INIT)
    assert c.failed
    with pytest.raises(ValueError):
        c.written(1)


@pytest.mark.parametrize('case', ['provider', 'network', 'roots', 'ephemeral', 'identity'])
def test_thread_profile_drift_prevents_turn(case):
    c = m.Controller()
    flush(c)
    reply(c, 1, INIT)
    flush(c)
    value = copy.deepcopy(THREAD)
    if case == 'provider': value['modelProvider'] = 'openai'
    if case == 'network': value['sandbox']['networkAccess'] = True
    if case == 'roots': value['runtimeWorkspaceRoots'] = []
    if case == 'ephemeral': value['thread']['ephemeral'] = False
    if case == 'identity': value['thread']['id'] = ''
    with pytest.raises(ValueError, match='THREAD_PROFILE'):
        reply(c, 2, value)
    assert c.failed and not c.pending


@pytest.mark.parametrize('case', ['server-request', 'wrong-thread', 'wrong-turn', 'error', 'failed'])
def test_unsolicited_request_or_false_completion_fails(case):
    c = active_controller()
    frame = {'method': 'turn/completed', 'params': {'threadId': 'fixture-thread',
        'turn': {'id': 'fixture-turn', 'status': 'completed', 'error': None}}}
    if case == 'server-request': frame['id'] = 90
    if case == 'wrong-thread': frame['params']['threadId'] = 'another'
    if case == 'wrong-turn': frame['params']['turn']['id'] = 'another'
    if case == 'error': frame['params']['turn']['error'] = {'message': 'failed'}
    if case == 'failed': frame['params']['turn']['status'] = 'failed'
    with pytest.raises(ValueError):
        c.receive(m.encode(frame) + b'\n')
    assert c.failed and not c.report()['turnCompleted']


@pytest.mark.parametrize('header', ['Authorization', 'Proxy-Authorization', 'Cookie',
    'X-Api-Key', 'Transfer-Encoding', 'Content-Encoding', 'Upgrade'])
def test_peer_refuses_auth_and_unsupported_transports(header):
    peer = m.ResponsesPeer()
    raw = m.encode(request())
    with pytest.raises(ValueError, match='UNSUPPORTED_HEADERS'):
        peer.prepare('POST', '/v1/responses', [('Content-Type', 'application/json'),
            ('Content-Length', str(len(raw))), (header, 'authored-placeholder')], raw)
    assert peer.failed and not peer.events


@pytest.mark.parametrize('case', ['duplicate-header', 'length', 'path', 'verb',
                                  'missing-tool', 'early-output', 'overflow', 'duplicate-json'])
def test_peer_rejects_malformed_or_unexpected_first_request(case):
    peer = m.ResponsesPeer()
    value = request(case == 'early-output')
    if case == 'missing-tool': value['tools'] = []
    raw = m.encode(value)
    if case == 'overflow': raw = raw[:-1] + b',"overflow":1e999}'
    if case == 'duplicate-json': raw = raw[:-1] + b',"stream":true}'
    headers = [('Content-Type', 'application/json'), ('Content-Length', str(len(raw)))]
    if case == 'duplicate-header': headers.append(('content-length', str(len(raw))))
    if case == 'length': headers[-1] = ('Content-Length', '0')
    with pytest.raises(ValueError):
        peer.prepare('GET' if case == 'verb' else 'POST',
            '/other' if case == 'path' else '/v1/responses', headers, raw)
    assert peer.failed
    if case == 'missing-tool':
        assert peer.events[0]['requestRawHex'] == raw.hex()
        assert peer.events[0]['responseRawHex'] is None
    with pytest.raises(ValueError, match='PEER_CLOSED'):
        prepare(peer, request())


@pytest.mark.parametrize('case', ['before-delivery', 'wrong-call', 'no-output', 'extra-output', 'third'])
def test_peer_requires_correlated_output_and_at_most_two_deliveries(case):
    peer = m.ResponsesPeer()
    first = prepare(peer, request())
    if case != 'before-delivery': peer.delivered(len(first))
    value = request(True)
    if case == 'wrong-call': value['input'][0]['call_id'] = 'other'
    if case == 'no-output': value['input'] = []
    if case == 'extra-output': value['input'] *= 2
    if case == 'third':
        second = prepare(peer, value)
        peer.delivered(len(second))
    with pytest.raises(ValueError):
        prepare(peer, value)
    assert peer.failed


def test_short_response_delivery_poisoned_peer():
    peer = m.ResponsesPeer()
    raw = prepare(peer, request())
    with pytest.raises(ValueError): peer.delivered(len(raw) - 1)
    assert peer.failed and not peer.report()['complete']


def test_controller_bounds_diagnostic_notifications():
    c = active_controller()
    c.total = m.MAX_TOTAL - 1
    with pytest.raises(ValueError, match='CONTROLLER_BYTE_BOUND'):
        c.receive(b'{"method":"diagnostic","params":{}}\n')
    assert c.failed


def test_responses_lite_additional_tools_observed_in_pinned_stock_client():
    peer = m.ResponsesPeer()
    value = request()
    value['input'].insert(0, {'type': 'additional_tools', 'role': 'developer',
                              'tools': value.pop('tools')})
    response = prepare(peer, value)
    assert events(response)[1]['item']['name'] == 'exec_command'
    assert peer.events[0]['requestRawHex'] == m.encode(value).hex()


@pytest.mark.parametrize('case', ['both', 'two', 'wrong-role'])
def test_ambiguous_responses_lite_catalog_is_refused(case):
    peer = m.ResponsesPeer()
    value = request()
    tools = value.pop('tools')
    value['input'] = [{'type': 'additional_tools', 'role': 'developer', 'tools': tools}]
    if case == 'both': value['tools'] = tools
    if case == 'two': value['input'] *= 2
    if case == 'wrong-role': value['input'][0]['role'] = 'user'
    with pytest.raises(ValueError, match='AMBIGUOUS_TOOL_CATALOG'):
        prepare(peer, value)
    assert peer.failed
