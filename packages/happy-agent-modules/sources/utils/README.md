# Shared utilities

Self-contained algorithms used across feature boundaries. `orderKeyBetween` is the existing
workspace catalog's decimal fractional-key implementation, shared with Surfaces without making
one feature import another feature's internals.

Monotonic UUIDv7 creation is shared here as well, so modules generate resource versions without
importing the event journal's implementation.
