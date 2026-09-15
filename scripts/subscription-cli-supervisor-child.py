"""Fixed credential-free child. No user command, prompt, auth or network."""
import json
import os
import signal
import sys
import time

assert sys.argv[1:] in [['sleep'], ['setsid'], ['flood'], ['paced-output']]
mode = sys.argv[1]
if mode == 'setsid':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    child = os.fork()
    if child == 0:
        os.setsid()
        print(json.dumps({'fixedChild': 'setsid-grandchild', 'pid': os.getpid()}), flush=True)
        while True:
            time.sleep(1)
print(json.dumps({'fixedChild': mode, 'pid': os.getpid()}), flush=True)
if mode == 'paced-output':
    # Fixed finite fixture: 9 MiB at 4 KiB/10ms. The supervisor's cap stays 8 MiB.
    for _ in range(9 * 1024 * 1024 // 4096):
        os.write(1, b'x' * 4096)
        time.sleep(0.01)
    raise SystemExit(0)
if mode == 'flood':
    while True:
        os.write(1, b'x' * 16384)
while True:
    time.sleep(1)
