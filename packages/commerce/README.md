# Commerce

Host-neutral Go contracts and client logic for membership, credits, and the
first-registration credits reward.

The package intentionally does not know Tutti or TSH session files, Cookie
formats, renderer state, Electron, or VM paths. A host must provide:

- a trusted Commerce base URL;
- a request authorizer;
- a host-local reward receipt store;
- optionally, its shared HTTP client and clock.

The host remains responsible for combining Commerce data with Account identity
and for mapping the result into its local API and UI.
