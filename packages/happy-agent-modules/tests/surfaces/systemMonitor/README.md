# System Monitor tests

parsers.test.ts contains fixed examples of documented procfs, ps, vm_stat, df, ioreg,
selected CIM JSON, and NVIDIA CSV output. sampler.test.ts controls time and probe
results to exercise ownership, resource bounds, and CPU identity semantics.

```text
output fixtures -> platform parsers -> typed telemetry
controlled clock/probes -> shared sampler -> bounded snapshots
```

The real API and model-tool scenarios live in the gym tests package.
