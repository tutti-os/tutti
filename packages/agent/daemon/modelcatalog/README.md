# Agent model catalog

`modelcatalog` owns the provider-neutral model capability contract shared by
Agent runtime adapters and their product hosts. It normalizes provider model
catalogs, projects those catalogs into runtime `configOptions`, and parses the
same descriptors back without losing per-model reasoning, speed, or input
capabilities.

Provider runtimes are responsible for publishing complete model descriptors.
Hosts such as `tuttid` and TSH's `desktopd` consume
`ParseRuntimeConfigOptionModels`; they must not copy provider-specific parsing
or infer missing capabilities. Process launch, transport, live-session lookup,
and caching remain responsibilities of each host adapter.

Field presence is part of the contract. An advertised empty capability list
means that the provider explicitly does not support that capability, while a
missing field means that the provider did not advertise it.
