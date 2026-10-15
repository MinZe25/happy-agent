# Shared utilities

Self-contained algorithms used across feature boundaries. `orderKeyBetween` is the existing
workspace catalog's decimal fractional-key implementation, shared with Surfaces without making
one feature import another feature's internals.

Monotonic UUIDv7 creation is shared here as well, so modules generate resource versions without
importing the event journal's implementation.

`apiResourceVersion` projects a module's numeric record version into the deterministic UUIDv7
that the API exposes. It lives here so a feature can report another resource's public version,
as Surface references do, without importing the API module's projection code.
