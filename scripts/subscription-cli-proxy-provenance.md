# Own CLI endpoint provenance observer

Implementation only, no actual kernel/process experiment. The first source draft
was captured untested in checkpoint8; subsequent edits/tests are newer sources.

`create_observer(process, retained_pidfd, start_ticks, network_namespace, deadline)`
accepts a trusted parent's own fixed Popen and retained pin. These arguments are
a trusted-caller ownership contract, not authorization to observe arbitrary PIDs
or a cryptographic attestation. It owns only a noninheritable duplicate of that
pin; the original pin and process reaping remain the parent's responsibility.

The returned callable accepts exactly `accepted-before-read`, followed by
`header-complete-before-refusal`, with an actual accepted socket observation
`{peer:[127.0.0.1,clientPort],local:[127.0.0.1,proxyPort],socket:{dev,ino,type}}`.
Both calls use one absolute caller deadline, at most two seconds at creation.
It checks own poll/pidfd/starttime and matching observer/CLI network namespaces
before and after each bounded sequential snapshot. The IPv4 TCP table is capped
at 64 KiB/256 rows; exactly one ESTABLISHED client-side tuple and nonzero inode
must appear. Only `/proc/<own pid>/fd` is enumerated (256 entries), and only
readlink metadata is inspected for matching holders. No descriptor contents,
fdinfo, executable, environment, credentials or unrelated PID directories are
read. Process stat is capped at 4 KiB. Deadlines are checked around metadata I/O.

Typed records retain bounded TCP/stat bytes, hashes, holder indexes, counts and
before/after identities. `validate_records` independently binds both snapshots
to externally supplied expected process identity and accepted observation.
The same tuple, accepted socket and client inode must remain consistent. This
proves sequential endpoint membership, not exclusive ownership or atomic
authorship of every byte. An inherited/shared socket is possible; actual
attribution also depends on the fixed clean launch and no untrusted descendants.

Unknown/racing observations and duplicate close failure fence subsequent factory
creation in that module. Closing the pin is not CLI process cleanup. The parent
must retain its own pin through process cleanup and the external measurement
must validate that separately. No generic RPC, authentication, network connector,
deadline extension, successful CONNECT or model-inference credit is introduced.
