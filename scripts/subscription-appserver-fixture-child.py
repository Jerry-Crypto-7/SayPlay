"""Authored protocol fixture only. No Codex, model, network or credential access."""
import importlib.util
import json
import os
import selectors
import sys
import time

MAX_INPUT = 2 * 1024 * 1024
MAX_LINE = 1100000
SCENARIOS = ('normal', 'cancel', 'output-limit')


class Protocol:
    def __init__(self, scenario):
        if scenario not in SCENARIOS:
            raise ValueError('INVALID_SCENARIO')
        self.scenario = scenario
        self.stage = 0

    def receive(self, frame):
        if not isinstance(frame, dict) or 'jsonrpc' in frame:
            raise ValueError('INVALID_FRAME')
        methods = ('initialize', 'initialized', 'thread/start', 'turn/start')
        if self.stage >= len(methods) or frame.get('method') != methods[self.stage]:
            raise ValueError('UNEXPECTED_METHOD')
        expected_id = (1, None, 2, 3)[self.stage]
        if set(frame) != ({'method', 'params'} if expected_id is None else {'id', 'method', 'params'}):
            raise ValueError('INVALID_ENVELOPE')
        if expected_id is not None and (type(frame['id']) is not int or frame['id'] != expected_id):
            raise ValueError('INVALID_ID')
        if not isinstance(frame['params'], dict):
            raise ValueError('INVALID_PARAMS')
        self.stage += 1
        if self.stage == 1:
            return [{'id': 1, 'result': {'userAgent': 'AUTHORED_PROTOCOL_FIXTURE', 'platformFamily': 'unix',
                    'platformOs': 'linux', 'codexHome': '/work/appserver-home/fixed-fixture0'}}]
        if self.stage == 2:
            return []
        if self.stage == 3:
            return [{'id': 2, 'result': {'thread': {'id': 'fixture-thread', 'ephemeral': True, 'path': None},
                    'model': 'gpt-5.6-sol', 'modelProvider': 'openai', 'reasoningEffort': 'low', 'cwd': '/work',
                    'approvalPolicy': 'never', 'runtimeWorkspaceRoots': [],
                    'sandbox': {'type': 'readOnly', 'networkAccess': False}}}]
        turn = {'id': 'fixture-turn', 'status': 'inProgress', 'items': [], 'error': None}
        frames = [{'id': 3, 'result': {'turn': turn}},
                  {'method': 'turn/started', 'params': {'threadId': 'fixture-thread', 'turn': turn}}]
        if self.scenario != 'normal':
            return frames
        params = {'threadId': 'fixture-thread', 'turnId': 'fixture-turn'}
        item = {'type': 'agentMessage', 'id': 'fixture-item', 'text': '', 'phase': 'final_answer'}
        text = '{"authoredFixture":true,"actualModelCalls":0}'
        frames += [
            {'method': 'item/started', 'params': {**params, 'item': item}},
            {'method': 'item/agentMessage/delta', 'params': {**params, 'itemId': item['id'], 'delta': text}},
            {'method': 'item/completed', 'params': {**params, 'item': {**item, 'text': text}}},
            {'method': 'turn/completed', 'params': {'threadId': 'fixture-thread', 'turn': {**turn, 'status': 'completed'}}},
        ]
        return frames


def install_fixed_lockdown():
    # Loaded only after fixed argv admission, from the read-only capsule image.
    # The supervisor binds this exact helper's hash before dispatch. Never fall
    # back to an import path, caller module or unfiltered protocol operation.
    spec = importlib.util.spec_from_file_location('fixed_fixture_lockdown', '/usr/bin/worker-lockdown.py')
    if spec is None or spec.loader is None:
        raise RuntimeError('FIXTURE_LOCKDOWN_LOADER_REQUIRED')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.install_worker_lockdown()


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in SCENARIOS:
        raise ValueError('FIXED_SCENARIO_REQUIRED')
    install_fixed_lockdown()
    protocol = Protocol(sys.argv[1])
    selector = selectors.DefaultSelector()
    for fd in (0, 1, 2):
        os.set_blocking(fd, False)
    selector.register(0, selectors.EVENT_READ)
    pending = bytearray()
    output = bytearray()
    total = 0
    began = time.monotonic()
    flood_bytes = 0
    while time.monotonic() - began < 180:
        if protocol.stage == 4 and protocol.scenario == 'output-limit' and flood_bytes < 8388608 + 65536:
            try:
                flood_bytes += os.write(2, b'x' * 4096)
            except BlockingIOError:
                pass
        if output:
            try:
                count = os.write(1, output)
                del output[:count]
            except BlockingIOError:
                pass
        for key, _ in selector.select(0.01):
            raw = os.read(key.fd, 4096)
            if not raw:
                return
            total += len(raw)
            if total > MAX_INPUT:
                raise ValueError('INPUT_LIMIT')
            pending.extend(raw)
            while b'\n' in pending:
                line, _, rest = pending.partition(b'\n')
                pending = bytearray(rest)
                if len(line) > MAX_LINE:
                    raise ValueError('LINE_LIMIT')
                for frame in protocol.receive(json.loads(line)):
                    output.extend((json.dumps(frame, separators=(',', ':')) + '\n').encode())
                if len(output) > 65536:
                    raise ValueError('OUTPUT_QUEUE_LIMIT')
            if len(pending) > MAX_LINE:
                raise ValueError('LINE_LIMIT')
    raise TimeoutError('FIXTURE_JOB_DEADLINE')


if __name__ == '__main__':
    main()
