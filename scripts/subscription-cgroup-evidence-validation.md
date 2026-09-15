# Completed common-view document linkage

This pure helper links six completed documents to the same live observer
identity, visible cgroup hierarchy and separately owned target leaf. It invokes
the actual source-bound service, sampler and target-ancestry validators and
checks source projections, ordering and chronology. It performs no I/O.

The fixed target composition reuses the exact still-fresh `capacity-after-open`
snapshot; its nonzero sampling duration is not mistaken for an ordering
violation. A different snapshot is rejected. The target validator independently enforces its five-second
freshness bound and captures new before/after observations.

This result alone never admits stress or authenticates a dispatcher. The caller
must separately validate transport completeness, actual capacity raw records
and their timing between the paired snapshots, target manager binding, resource
events, actual action delivery and final cleanup. No integration or actual run
has yet established those combined properties for this later implementation.
