"""Fixed stdlib-only AF_UNIX fixture measurement; never connects to a network."""
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import sys
import threading
import time

MODULE = Path(__file__).with_name('subscription-trusted-egress-proxy.py')
SELF = Path(__file__)
SCENARIOS = ('normal', 'cancel', 'bad-control', 'control-eof', 'negotiation-deadline', 'backpressure-cancel')
PAYLOAD = bytes(range(256)) * 4
TOTAL_SECONDS = 20.0


def frozen_module():
    raw = MODULE.read_bytes()
    spec = importlib.util.spec_from_file_location('fixed_offline_egress', MODULE)
    module = importlib.util.module_from_spec(spec)
    exec(compile(raw, str(MODULE), 'exec'), module.__dict__)
    return module, hashlib.sha256(raw).hexdigest()


def hashes():
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (MODULE, SELF)}


def recv_exact(peer, size, deadline):
    result = bytearray()
    while len(result) < size:
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError('PEER_DEADLINE')
        peer.settimeout(min(1.0, remaining))
        raw = peer.recv(size - len(result))
        if not raw: raise ValueError('EARLY_PEER_EOF')
        result.extend(raw)
    return bytes(result)


def validate_case(record):
    try:
        name = record['scenario']; report = record['broker']
        reasons = {'normal': 'EOF', 'cancel': 'CANCELLED', 'bad-control': 'CONTROL_REFUSED',
            'control-eof': 'CANCELLED', 'negotiation-deadline': 'NEGOTIATION_DEADLINE', 'backpressure-cancel': 'CANCELLED'}
        if (name not in reasons or record['error'] is not None or record['threadClosed'] is not True
                or record['peersClosed'] is not True or report['brokerDescriptorsClosed'] is not True
                or report['reason'] != reasons[name] or report['productionReady'] is not False
                or type(report['externalNetworkCalls']) is not int or report['externalNetworkCalls'] != 0
                or type(report['modelCalls']) is not int or report['modelCalls'] != 0): return False
        if name == 'normal':
            if record['payloadChecks'] != {'forward': hashlib.sha256(PAYLOAD).hexdigest(), 'reverse': hashlib.sha256(PAYLOAD[::-1]).hexdigest(), 'halfCloseEOF': True}: return False
        if type(report['elapsedMs']) is not int or not 0 <= report['elapsedMs'] < 5500: return False
        if name == 'negotiation-deadline' and (report['elapsedMs'] < 2000 or report['connectAccepted'] is not False): return False
        if name == 'backpressure-cancel' and (record['sendWouldBlock'] is not True or record['acceptedPayloadBytes'] <= 0): return False
        return True
    except (KeyError, TypeError, ValueError): return False


def run_case(module, name, global_deadline):
    if name not in SCENARIOS: raise ValueError('FIXED_SCENARIO_REQUIRED')
    broker, client, upstream, control = module.create_offline_session()
    peers = (client, upstream, control)
    output = []; failures = []
    def work():
        try: output.append(broker.run())
        except BaseException as error: failures.append(type(error).__name__)
    thread = None
    record = {'scenario': name, 'error': None, 'broker': None, 'threadClosed': False, 'peersClosed': False,
        'payloadChecks': None, 'sendWouldBlock': False, 'acceptedPayloadBytes': 0}
    local_deadline = min(global_deadline, time.monotonic() + module.SESSION_SECONDS + 0.5)
    started = False
    try:
        thread = threading.Thread(target=work, daemon=True)
        for peer in peers: peer.settimeout(1.0)
        if name == 'backpressure-cancel':
            # Only owned offline socketpair buffers; deliberately no upstream reads.
            broker._sockets[1].setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
            client.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
        thread.start()
        started = True
        if name in ('normal', 'backpressure-cancel'):
            client.sendall(module.REQUEST)
            if recv_exact(client, len(module.RESPONSE), local_deadline) != module.RESPONSE: raise ValueError('CONNECT_RESPONSE')
        if name == 'normal':
            client.sendall(PAYLOAD)
            forward = recv_exact(upstream, len(PAYLOAD), local_deadline)
            upstream.sendall(PAYLOAD[::-1])
            reverse = recv_exact(client, len(PAYLOAD), local_deadline)
            client.shutdown(socket.SHUT_WR)
            if upstream.recv(1) != b'': raise ValueError('HALFCLOSE_FORWARD')
            upstream.shutdown(socket.SHUT_WR)
            if client.recv(1) != b'': raise ValueError('HALFCLOSE_REVERSE')
            record['payloadChecks'] = {'forward': hashlib.sha256(forward).hexdigest(),
                'reverse': hashlib.sha256(reverse).hexdigest(), 'halfCloseEOF': True}
        elif name == 'cancel': control.sendall(b'C')
        elif name == 'bad-control': control.sendall(b'bad')
        elif name == 'control-eof': control.shutdown(socket.SHUT_WR)
        elif name == 'backpressure-cancel':
            client.setblocking(False)
            pressure_deadline = min(local_deadline, time.monotonic() + 1.0)
            while record['acceptedPayloadBytes'] < 262144 and time.monotonic() < pressure_deadline:
                try: record['acceptedPayloadBytes'] += client.send(PAYLOAD)
                except BlockingIOError:
                    record['sendWouldBlock'] = True; break
            control.sendall(b'C')
        # For normal do not close control until the broker sealed true EOF.
        # Negotiation deadline deliberately waits for the original full 2 s.
        thread.join(max(0.0, local_deadline - time.monotonic()))
        if thread.is_alive(): raise TimeoutError('BROKER_THREAD_UNKNOWN')
        if failures: raise ValueError('BROKER_THREAD_ERROR')
    except (OSError, ValueError, RuntimeError) as error:
        record['error'] = type(error).__name__
        if thread is not None and thread.is_alive(): started = True
    finally:
        for peer in peers:
            try: peer.close()
            except OSError: pass
        if not started:
            for endpoint in broker._sockets:
                try: endpoint.close()
                except OSError: pass
            broker.cleanup_known = all(endpoint.fileno() == -1 for endpoint in broker._sockets)
            if not broker.cleanup_known: module._UNCERTAIN_CLEANUP = True
        record['setupBrokerDescriptorsClosed'] = broker.cleanup_known if not started else None
        record['threadStarted'] = started
        record['peersClosed'] = all(peer.fileno() == -1 for peer in peers)
        record['threadClosed'] = not started or not thread.is_alive()
        record['broker'] = output[0] if len(output) == 1 else None
    record['passed'] = validate_case(record)
    return record


def run():
    began = time.monotonic(); before = hashes(); module, loaded = frozen_module()
    report = {'version': 1, 'profile': 'fixed-af-unix-egress-precursor', 'sourceBefore': before,
        'sourceAfter': None, 'loadedModuleSha256': loaded, 'cases': [], 'passed': False,
        'productionReady': False, 'untrustedNamespaceTest': 'NOT_RUN', 'processKillTest': 'NOT_RUN',
        'authTest': 'NOT_RUN', 'externalNetworkTest': 'NOT_RUN'}
    if loaded != before[MODULE.name]: raise ValueError('SOURCE_CHANGED_BEFORE_LOAD')
    for name in SCENARIOS:
        if time.monotonic() - began >= TOTAL_SECONDS: break
        try: result = run_case(module, name, began + TOTAL_SECONDS)
        except (OSError, ValueError, AttributeError) as error:
            result = {'scenario': name, 'passed': False, 'error': type(error).__name__,
                'threadClosed': False, 'peersClosed': False, 'broker': None}
        report['cases'].append(result)
        # No next dispatch after failure, including any uncertain thread/FD cleanup.
        if not result['passed']: break
    report['sourceAfter'] = hashes()
    report['elapsedMs'] = round((time.monotonic() - began) * 1000)
    report['passed'] = (len(report['cases']) == len(SCENARIOS) and all(v['passed'] for v in report['cases'])
        and report['sourceBefore'] == report['sourceAfter'] and report['elapsedMs'] < TOTAL_SECONDS * 1000)
    return report


def main():
    if sys.argv[1:]: raise ValueError('FIXED_NO_ARGUMENTS')
    report = run()
    raw = json.dumps(report, allow_nan=False, separators=(',', ':'))
    if len(raw.encode()) > 32768: raise ValueError('BOUNDED_REPORT_LIMIT')
    print(raw)
    return 0 if report['passed'] else 1


if __name__ == '__main__': raise SystemExit(main())
