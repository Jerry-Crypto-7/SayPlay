"""Credential-free executable inventory, not runtime or authentication validation.

Run with system Python -I -S in WSL and an empty environment. Only the named
installation locations are inspected; never recurse through a home directory.
Nothing found here is executed, and no credential/config/session file is read.
"""
import glob
import json
import os
import platform
from pathlib import Path


def inventory():
    candidates = set()
    for pattern in (
        '/usr/bin/codex', '/usr/local/bin/codex',
        '/home/*/.local/bin/codex',
        '/home/*/.nvm/versions/node/*/bin/codex',
        '/opt/*/bin/codex',
    ):
        candidates.update(glob.glob(pattern))
    entries = []
    for name in sorted(candidates):
        path = Path(name)
        # Resolve names only. Reading wrapper text could expose arbitrary data
        # through a symlink, so this inventory deliberately does not read bytes.
        target = path.resolve()
        entries.append({'path': name, 'resolvedPath': str(target),
                        'isFile': target.is_file(),
                        'windowsMount': str(target).startswith('/mnt/'),
                        'executable': os.access(target, os.X_OK)})
    return {'version': 'subscription-runtime-inventory-v1',
            'kernel': platform.release(), 'machine': platform.machine(),
            'candidates': entries, 'executedCLI': False,
            'credentialFilesRead': False, 'runtimeValidated': False,
            'authValidated': False, 'networkValidated': False}


if __name__ == '__main__':
    print(json.dumps(inventory(), sort_keys=True))
