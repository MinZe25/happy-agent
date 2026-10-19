# System Monitor

One `SystemMonitorSampler` belongs to the daemon's Surfaces module. Named Surfaces share it;
their catalog version, members, and shared chat remain ordinary Surface data.

```text
HTTP / read_system_monitor -> SurfacesModule validates type -> latest snapshot
                                                                ^
daemon lifetime -> lazy sampler -> independent bounded probes ---|
                                  CPU/memory/GPU/disk/processes
```

The sampler starts on the first read, recommends a one-second polling interval, and stops after
60 seconds without reads. It retains at most 300 chronological points. Its detached named
context owns probe processes and cancellation; neither an HTTP request nor a tool owns that
lifetime. Each probe lane has a deadline and allows only one outstanding operation, including
when a filesystem call has timed out without settling. Slow process scans cannot delay other
metrics. Shutdown cancels commands and timers. Telemetry has no durable state or events.

Linux uses procfs and sysfs. CPU process deltas divide by total machine ticks, avoiding a
single-core percentage and double-counted guest time. Real mount types are filtered before
statfs; disk activity counts whole physical devices, excluding mapped layers and partitions.
Memory uses MemAvailable. macOS uses bounded vm_stat, sysctl, ps, df, and ioreg probes:
anonymous, wired, and compressed memory account for occupied RAM while file-backed cache is
reported separately. Accelerator performance statistics provide available Apple/Intel GPU
readings. Windows uses OS CPU and memory counters, NVIDIA telemetry when installed, and bounded
selected CIM properties for disks, GPU identity, and processes, refreshing expensive probes
every five seconds. Unavailable measurements remain null or empty arrays.
If native memory accounting fails, the required byte totals fall back to Node's total/free
memory with cache unknown; that fallback may include reclaimable cache in used memory.

Process scans retain only executable names, identities, cumulative CPU, RSS, thread counts,
and available attribution/state. They never read command lines or environments. The public list
is the union of the top 50 CPU and top 50 memory processes, sorted by CPU, with at most 100 rows.
CPU baselines include start identities, are pruned on each scan, and reset on idle restart or
failed scans. The model receives a compact summary including the top five by each measure.

Fixture tests exercise Linux, macOS, Windows, and NVIDIA output formats without a remote Mac.
Sampler tests prove bounded history, initial CPU baselines, concurrent reads, stalled probes,
PID reuse, idle stopping, and cancellation. Gym scenarios exercise the real daemon API, tools,
catalog events, shared chats, and restart behavior.
