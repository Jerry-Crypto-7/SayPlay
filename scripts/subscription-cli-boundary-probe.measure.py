"""Fixed credential-free boundary measurement; no caller arguments."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import uuid
assert len(sys.argv) == 1
sources = ['scripts/subscription-cli-boundary-probe.sh', 'scripts/subscription-cli-boundary-probe.py',
           'scripts/subscription-cli-boundary-probe-child.py', 'scripts/subscription-cli-boundary-probe.measure.py',
           'scripts/subscription-runtime-probe.py', 'scripts/subscription-runtime-child-probe.py',
           'scripts/subscription-cli-supervisor.py', 'scripts/subscription-cli-supervisor.sh']
def hashes():
    return {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in sources}
command = ['wsl.exe', '-d', 'Ubuntu-24.04', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
           '/usr/bin/timeout', '--signal=TERM', '--kill-after=5', '40', '/usr/bin/unshare',
           '--user', '--map-current-user', '--keep-caps', '--mount', '--net', '--pid', '--fork',
           '/bin/sh', '/mnt/d/claude/Hackaton/scripts/subscription-cli-boundary-probe.sh']
path = Path('scratch') / ('session7-cli-boundary-' + str(uuid.uuid4()) + '.json')
report = {'version': 1, 'state': 'PREPARED', 'command': command, 'sourceSha256Before': hashes(),
          'productionReady': False, 'scenarioPassed': False}
path.write_text(json.dumps(report, indent=2))
try:
    result = subprocess.run(command, input=b'', capture_output=True, timeout=47)
    report.update(state='FINISHED', exitCode=result.returncode, stdout=result.stdout.decode('utf-8', errors='replace'),
                  stderr=result.stderr.decode('utf-8', errors='replace'))
    try:
        report['result'] = json.loads(result.stdout)
    except (ValueError, UnicodeError):
        report['result'] = None
    report['sourceSha256After'] = hashes()
    report['scenarioPassed'] = bool(result.returncode == 0 and report['result'] and
                                   report['result'].get('boundedExperimentPassed') is True and
                                   report['sourceSha256Before'] == report['sourceSha256After'])
except (OSError, subprocess.TimeoutExpired) as error:
    report.update(state='FAILED', error=str(error), cleanupStatus='UNKNOWN')
path.write_text(json.dumps(report, indent=2))
print(json.dumps({'artifact': str(path), 'scenarioPassed': report['scenarioPassed'],
                  'boundedExperimentPassed': report.get('result', {}).get('boundedExperimentPassed') if report.get('result') else None, 'stderr': report.get('stderr'), 'error': report.get('error')}))
raise SystemExit(0 if report['scenarioPassed'] else 1)
