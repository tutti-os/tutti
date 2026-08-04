# @tutti-os/agent-session-replay

Provider-neutral renderer contracts and replay mechanics for Agent Session Replay.

This package owns the portable activity event type and the interaction
contract shared by Tutti Desktop and TSH, plus the engine-facing activity
replay driver, generic React binding, and Workspace bridge protocol type.
Product adapters keep ownership of scope mapping, persistence, HTTP/Electron
integration, replay runners, and provider/runtime setup.

The package does not enable recording or replay by itself. Hosts must mount the
React binding only for an explicitly selected replay session; ordinary
AgentGUI rendering and provider execution remain unchanged. Import the
`react-binding` entry only from a renderer that already provides React.
