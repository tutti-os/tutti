// Command providercapabilitycatalog emits the canonical agent capability keys.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func main() {
	if err := providerregistry.ValidateMigrated(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(providerregistry.KnownCapabilities()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
