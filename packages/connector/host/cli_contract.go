package host

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
)

const managedCLIContractVersion = 1

type managedCLIContract struct {
	Version   int                         `json:"version"`
	Command   string                      `json:"command"`
	Arguments []string                    `json:"arguments,omitempty"`
	TimeoutMS int                         `json:"timeoutMs,omitempty"`
	Commands  []managedCLICommandContract `json:"commands,omitempty"`
}

type managedCLICommandContract struct {
	Name        string         `json:"name"`
	Arguments   []string       `json:"arguments,omitempty"`
	InputSchema map[string]any `json:"inputSchema"`
	TimeoutMS   int            `json:"timeoutMs"`
}

// ManagedCLIContractHash returns a stable digest of the caller-visible CLI
// invocation contract. Implementation-only details such as entrypoint paths,
// installation recipes, and descriptions are deliberately excluded.
func ManagedCLIContractHash(cli ManagedCLIInterface) (string, error) {
	contract := managedCLIContract{
		Version: managedCLIContractVersion, Command: ManagedCLICommandName(cli), Arguments: append([]string(nil), cli.Arguments...), TimeoutMS: cli.TimeoutMS,
		Commands: make([]managedCLICommandContract, 0, len(cli.Commands)),
	}
	for _, command := range cli.Commands {
		contract.Commands = append(contract.Commands, managedCLICommandContract{
			Name: command.Name, Arguments: append([]string(nil), command.Arguments...), InputSchema: command.InputSchema,
			TimeoutMS: command.TimeoutMS,
		})
	}
	sort.Slice(contract.Commands, func(left, right int) bool { return contract.Commands[left].Name < contract.Commands[right].Name })
	raw, err := json.Marshal(contract)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

// ManagedCLICommandName returns the signed Agent-facing command projection.
// Older manifests derive it from the safe relative entrypoint; new manifests
// may declare an explicit command to decouple public syntax from layout.
func ManagedCLICommandName(cli ManagedCLIInterface) string {
	if command := strings.TrimSpace(cli.Command); command != "" {
		return command
	}
	return filepath.Base(filepath.Clean(filepath.FromSlash(strings.TrimSpace(cli.Entrypoint))))
}
