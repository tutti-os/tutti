package agentsessionreplay

import replay "github.com/tutti-os/tutti/packages/agent/session-replay"

var ErrCassetteAlreadyExists = replay.ErrCassetteAlreadyExists

type Store = replay.Store
type SemanticCassetteReader = replay.SemanticCassetteReader

var NewSemanticCassetteReader = replay.NewSemanticCassetteReader
