# Fixed HTTP capsule launcher composition

This new no-argument Linux entry loads a private, source-bound copy of the
existing ingress launcher. It changes only the literal shell selector to
`--trusted-http-ingress-fd` and adds its own file plus the four HTTP helpers to
the exact 19-source map. Shared launcher source is unchanged.

Actual ownership and terminal frames are emitted by that original runtime;
they are not reconstructed. The original AF_UNIX FD198 ownership, nonce,
67-byte broker CONNECT, BEFORE/AFTER challenges, ACKs, EOF, bounded emission,
single-use fence, timeout 200/grace5 and separate launcher cleanup remain.
The new entry also fences repeated calls even after setup failure. It supplies
no URLs, auth, environment overrides, caller descriptors or arbitrary commands.

The child now performs both opaque challenges after the worker probe, through
its local HTTP adapter. This launcher supplies only the existing authored
broker response and nonce replies; it cannot prove HTTP normalization or
worker exclusion by itself. Those require the child's raw evidence and the
dedicated capsule measurement. No actual run is claimed here; joint source
review and a separate runtime handoff remain required.
