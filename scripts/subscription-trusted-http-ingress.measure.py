"""Fixed Linux loopback/AF_UNIX HTTP ingress experiments; no external traffic."""
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import select
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
SELF = 'scripts/subscription-trusted-http-ingress.measure.py'
CORE = 'scripts/subscription-trusted-http-ingress.py'
SCENARIOS = ('fragmented-halfclose', 'wrong-request', 'malformed-response', 'cancel-backpressure', 'negotiation-deadline', 'normalization-halfclose')
CLIENT_OPAQUE = b'authored-client-opaque\x00\xff\n'
PEER_OPAQUE = b'authored-peer-opaque\x00\xfe\n'
BURST = b'B' * (512 * 1024)
LIMIT = 1024 * 1024
LOADED_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in (SELF, CORE)}


def load_core(before):
    raw = (ROOT / CORE).read_bytes()
    if hashlib.sha256(raw).hexdigest() != before.get(CORE): raise ValueError('CORE_SOURCE_DRIFT')
    spec = importlib.util.spec_from_file_location('fixed_http_ingress_measure_core', ROOT / CORE)
    core = importlib.util.module_from_spec(spec); exec(compile(raw, str(ROOT / CORE), 'exec'), core.__dict__)
    return core


def fd_inventory():
    import errno, stat
    result = {}
    for name in os.listdir('/proc/self/fd'):
        if not name.isdecimal(): continue
        try:
            value = os.fstat(int(name)); result[name] = [value.st_dev, value.st_ino, stat.S_IFMT(value.st_mode)]
        except OSError as error:
            if error.errno != errno.EBADF: raise
    return result


def io_wait(endpoint, write, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0: raise TimeoutError('HARNESS_IO_DEADLINE')
    select.select([] if write else [endpoint], [endpoint] if write else [], [], min(0.01, remaining))


def send(endpoint, raw, archive, deadline, allow_partial=False):
    offset = 0
    while offset < len(raw):
        if time.monotonic() >= deadline:
            if allow_partial: break
            raise TimeoutError('HARNESS_SEND_DEADLINE')
        try: count = endpoint.send(raw[offset:])
        except BlockingIOError:
            try: io_wait(endpoint, True, deadline)
            except TimeoutError:
                if allow_partial: break
                raise
            continue
        if count <= 0: raise OSError('HARNESS_SEND_CLOSED')
        archive.extend(raw[offset:offset + count]); offset += count
    return offset


def receive(endpoint, archive, deadline, count=None):
    while count is None or len(archive) < count:
        if time.monotonic() >= deadline: raise TimeoutError('HARNESS_RECEIVE_DEADLINE')
        try: block = endpoint.recv(min(4096, LIMIT - len(archive) + 1))
        except BlockingIOError: io_wait(endpoint, False, deadline); continue
        if not block: return True
        archive.extend(block)
        if len(archive) > LIMIT: raise ValueError('HARNESS_RAW_LIMIT')
    return False


def run_scenario(core, name):
    if name not in SCENARIOS: raise ValueError('FIXED_SCENARIO_REQUIRED')
    before = fd_inventory(); session = None; peers = []; thread = None; started = False
    captured = {}; errors = []; adapter = []
    raw = {key: bytearray() for key in ('clientSent', 'clientReceived', 'ingressSent', 'ingressReceived', 'controlSent')}
    began = time.monotonic()
    try:
        factory = core.create_pinned_wss_fixture_session if name == 'normalization-halfclose' else core.create_offline_session
        request = core.PINNED_WSS_REQUEST if name == 'normalization-halfclose' else core.REQUEST
        session, client, ingress, control = factory(); peers = [client, ingress, control]
        captured['ownership'] = session.ownership
        deadline = session.began + core.SESSION_SECONDS
        def run():
            try: adapter.append(session.run())
            except BaseException as error: errors.append(type(error).__name__ + ':SESSION_THREAD')
        thread = threading.Thread(target=run, daemon=True); thread.start(); started = True
        if name == 'negotiation-deadline':
            pass
        elif name == 'wrong-request':
            send(client, core.REQUEST.replace(b'fixture.invalid:443', b'wrong.invalid:443'), raw['clientSent'], deadline)
            captured['clientEOF'] = receive(client, raw['clientReceived'], deadline)
            captured['ingressEOF'] = receive(ingress, raw['ingressReceived'], deadline)
        else:
            for fragment in (request[:1], request[1:9], request[9:]):
                send(client, fragment, raw['clientSent'], deadline)
            receive(ingress, raw['ingressReceived'], deadline, len(core.REQUEST))
            if bytes(raw['ingressReceived']) != core.REQUEST: raise ValueError('ACTUAL_CONNECT_FORWARD_REQUIRED')
            if name == 'malformed-response':
                send(ingress, b'HTTP/1.1 403 Forbidden\r\n\r\n', raw['ingressSent'], deadline)
                captured['clientEOF'] = receive(client, raw['clientReceived'], deadline)
            else:
                for fragment in (core.RESPONSE[:5], core.RESPONSE[5:]): send(ingress, fragment, raw['ingressSent'], deadline)
                receive(client, raw['clientReceived'], deadline, len(core.RESPONSE))
                if bytes(raw['clientReceived']) != core.RESPONSE: raise ValueError('ACTUAL_RESPONSE_REQUIRED')
                if name in ('fragmented-halfclose', 'normalization-halfclose'):
                    send(client, CLIENT_OPAQUE, raw['clientSent'], deadline); client.shutdown(1)
                    captured['ingressEOF'] = receive(ingress, raw['ingressReceived'], deadline)
                    send(ingress, PEER_OPAQUE, raw['ingressSent'], deadline); ingress.shutdown(1)
                    captured['clientEOF'] = receive(client, raw['clientReceived'], deadline)
                else:
                    # Deliberately stop reading ingress after its actual response.
                    send(client, BURST, raw['clientSent'], min(deadline, time.monotonic() + 0.10), allow_partial=True)
                    time.sleep(min(0.05, max(0, deadline - time.monotonic())))
                    send(control, b'C', raw['controlSent'], deadline)
        thread.join(timeout=max(0, session.began + core.SESSION_SECONDS + 0.5 - time.monotonic()))
    except (OSError, ValueError, RuntimeError) as error:
        errors.append(type(error).__name__ + ':' + str(error)[:160])
    finally:
        if session is not None and not started:
            try: session.close()
            except Exception as error: errors.append(type(error).__name__ + ':UNSTARTED_SESSION_CLOSE')
        for peer in peers:
            try: peer.close()
            except OSError as error: errors.append(type(error).__name__ + ':PEER_CLOSE')
        if started and thread.is_alive(): thread.join(timeout=0.5)
    after = fd_inventory()
    result = {'scenario': name, 'captured': captured, 'adapter': adapter[0] if len(adapter) == 1 else None,
        'errors': errors, 'raw': {key: {'hex': bytes(value).hex(), 'bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest()} for key, value in raw.items()},
        'elapsedMs': (time.monotonic() - began) * 1000, 'cleanup': {'before': before, 'after': after,
            'peersClosed': all(peer.fileno() == -1 for peer in peers), 'threadClosed': thread is not None and not thread.is_alive()}}
    result['cleanup']['verified'] = result['cleanup']['peersClosed'] and result['cleanup']['threadClosed'] and before == after
    result['passed'] = validate_scenario(result, core)
    return result


def validate_scenario(result, core):
    try:
        name = result['scenario']; report = result['adapter']; data = {}
        if name not in SCENARIOS or result['errors'] != [] or result['cleanup']['verified'] is not True: return False
        normalized = name == 'normalization-halfclose'
        if (report.get('profile') != ('pinned-wss-shaped-fixture' if normalized else 'authored-connect')
                or type(report.get('normalizedHeaderBytes')) is not int or report['normalizedHeaderBytes'] != (30 if normalized else 0)): return False
        if result['cleanup']['before'] != result['cleanup']['after'] or result['cleanup']['threadClosed'] is not True or result['cleanup']['peersClosed'] is not True: return False
        for key, value in result['raw'].items():
            raw = bytes.fromhex(value['hex'])
            if len(raw) > LIMIT or type(value['bytes']) is not int or value['bytes'] != len(raw) or value['sha256'] != hashlib.sha256(raw).hexdigest(): return False
            data[key] = raw
        if set(data) != {'clientSent', 'clientReceived', 'ingressSent', 'ingressReceived', 'controlSent'}: return False
        ownership = report['ownership']
        if type(ownership) is not dict or set(ownership) != {'address', 'expectedClient', 'listener', 'ingress', 'networkNamespace', 'accepted'}: return False
        for key in ('address', 'expectedClient'):
            pair = ownership[key]
            if type(pair) is not list or len(pair) != 2 or pair[0] != '127.0.0.1' or type(pair[1]) is not int or not 1 <= pair[1] <= 65535: return False
        if ownership['address'] == ownership['expectedClient'] or type(ownership['networkNamespace']) is not str or re.fullmatch(r'net:\[[1-9][0-9]*\]', ownership['networkNamespace']) is None: return False
        for key in ('listener', 'ingress', 'accepted'):
            value = ownership[key]
            if (type(value) is not dict or set(value) != {'dev', 'ino', 'type'} or any(type(v) is not int or v < 0 for v in value.values())
                    or value['ino'] == 0 or value['type'] != 49152): return False
        if len({(ownership[key]['dev'], ownership[key]['ino']) for key in ('listener', 'ingress', 'accepted')}) != 3: return False
        for field in ('observedBytes', 'deliveredBytes', 'retainedBytes'):
            value = report[field]
            maximum = core.QUEUE_LIMIT if field == 'retainedBytes' else LIMIT
            if type(value) is not dict or set(value) != {'client', 'ingress'} or any(type(v) is not int or not 0 <= v <= maximum for v in value.values()): return False
        retained = report['handshakeRetainedBytes']
        if type(retained) is not dict or set(retained) != {'request', 'response'} or any(type(v) is not int or not 0 <= v <= core.HEADER_LIMIT for v in retained.values()): return False
        if (sum(report['observedBytes'].values()) > LIMIT or report['observedBytes']['client'] > len(data['clientSent'])
                or report['observedBytes']['ingress'] > len(data['ingressSent'])
                or not len(data['clientReceived']) <= report['deliveredBytes']['client'] <= report['observedBytes']['ingress']
                or not len(data['ingressReceived']) <= report['deliveredBytes']['ingress'] <= report['observedBytes']['client']): return False
        if type(report['elapsedMs']) not in (int, float) or not 0 <= report['elapsedMs'] < 5000: return False
        if (report['productionReady'] is not False or type(report['modelCalls']) is not int or report['modelCalls'] != 0
                or type(report['credentialFilesRead']) is not int or report['credentialFilesRead'] != 0
                or report['cleanup']['known'] is not True or type(report['cleanup']['closed']) is not list or len(report['cleanup']['closed']) != 5
                or not all(value is True for value in report['cleanup']['closed'])
                or report['cleanup']['processCleanup'] != 'NOT_ATTESTED' or report['ownership'] != result['captured']['ownership']): return False
        if name in ('fragmented-halfclose', 'normalization-halfclose'):
            client_request = core.PINNED_WSS_REQUEST if normalized else core.REQUEST
            return (report['success'] is True and report['reason'] == 'EOF' and result['captured']['clientEOF'] is True and result['captured']['ingressEOF'] is True
                and data['clientSent'] == client_request + CLIENT_OPAQUE and data['ingressReceived'] == core.REQUEST + CLIENT_OPAQUE
                and data['ingressSent'] == data['clientReceived'] == core.RESPONSE + PEER_OPAQUE
                and report['observedBytes'] == {'client': len(data['clientSent']), 'ingress': len(data['ingressSent'])}
                and report['deliveredBytes'] == {'client': len(data['clientReceived']), 'ingress': len(data['ingressReceived'])}
                and report['observedBytes']['client'] - report['deliveredBytes']['ingress'] == report['normalizedHeaderBytes']
                and report['retainedBytes'] == {'client': 0, 'ingress': 0})
        if report['success'] is not False: return False
        if name == 'wrong-request': return (report['reason'] == 'HANDSHAKE_REFUSED' and data['ingressReceived'] == data['clientReceived'] == b''
            and data['clientSent'] == core.REQUEST.replace(b'fixture.invalid:443', b'wrong.invalid:443') and report['deliveredBytes'] == {'client': 0, 'ingress': 0})
        if name == 'malformed-response': return (report['reason'] == 'HANDSHAKE_REFUSED' and data['ingressReceived'] == core.REQUEST
            and data['ingressSent'] == b'HTTP/1.1 403 Forbidden\r\n\r\n' and data['clientReceived'] == b'' and report['deliveredBytes']['client'] == 0)
        if name == 'cancel-backpressure': return (report['reason'] == 'CANCELLED' and data['controlSent'] == b'C' and data['clientReceived'] == core.RESPONSE
            and report['retainedBytes']['ingress'] > 0 and report['observedBytes']['client'] > report['deliveredBytes']['ingress'])
        return (report['reason'] == 'NEGOTIATION_DEADLINE' and all(value == b'' for value in data.values()) and report['elapsedMs'] >= 2000)
    except (KeyError, TypeError, ValueError, AttributeError): return False


def execute(core):
    results = []
    for name in SCENARIOS:
        result = run_scenario(core, name); results.append(result)
        if result['passed'] is not True or result['cleanup']['verified'] is not True: break
    return results


def main():
    if sys.argv[1:] or sys.platform != 'linux': raise ValueError('FIXED_LINUX_NO_ARGUMENTS')
    before = hashes()
    if before[SELF] != LOADED_SHA: raise ValueError('LOADED_HARNESS_DRIFT')
    core = load_core(before)
    output = ROOT / 'scratch' / ('session8-trusted-http-ingress-' + str(uuid.uuid4()) + '.json')
    archive = output.with_suffix(''); archive.mkdir()
    for name, digest in before.items():
        raw = (ROOT / name).read_bytes()
        if hashlib.sha256(raw).hexdigest() != digest: raise ValueError('ARCHIVE_SOURCE_DRIFT')
        (archive / Path(name).name).write_bytes(raw)
    report = {'version': 1, 'scope': 'AUTHORED_LOCAL_HTTP_AND_UNIX', 'sourceBefore': before, 'sourceArchive': str(archive),
        'scenarios': [], 'passed': False, 'externalNetworkCalls': 0, 'actualModelCalls': 0, 'productionReady': False,
        'capsuleValidated': False, 'workerExclusionValidated': False}
    with output.open('x', encoding='utf-8') as file: json.dump(report, file, indent=2)
    try: report['scenarios'] = execute(core)
    except Exception as error: report['error'] = {'type': type(error).__name__, 'message': str(error)[:160]}
    report['sourceAfter'] = hashes()
    report['passed'] = before == report['sourceAfter'] and len(report['scenarios']) == len(SCENARIOS) and all(value['passed'] is True for value in report['scenarios'])
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'path': str(output), 'passed': report['passed']}))
    return 0 if report['passed'] else 1


if __name__ == '__main__': raise SystemExit(main())
