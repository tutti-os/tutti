package account

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/tutti-os/tutti/packages/commerce"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const registrationCreditsRewardStateFile = "registration-credits-reward.json"

// ErrRegistrationCreditsRewardIDRequired keeps the existing account service
// contract while the implementation is owned by the peer Commerce package.
var ErrRegistrationCreditsRewardIDRequired = commerce.ErrRegistrationCreditsRewardIDRequired

type registrationCreditsRewardStore struct {
	path string
}

func (s *registrationCreditsRewardStore) Load(context.Context) (commerce.RewardReceiptState, error) {
	body, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return commerce.RewardReceiptState{}, nil
		}
		return commerce.RewardReceiptState{}, err
	}
	var state commerce.RewardReceiptState
	if err := json.Unmarshal(body, &state); err != nil {
		return commerce.RewardReceiptState{}, err
	}
	return state, nil
}

func (s *registrationCreditsRewardStore) Save(
	_ context.Context,
	state commerce.RewardReceiptState,
) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, append(body, '\n'), 0o600)
}

func (s *Service) registrationCreditsRewardStatePath() string {
	if strings.TrimSpace(s.RegistrationCreditsRewardStatePath) != "" {
		return strings.TrimSpace(s.RegistrationCreditsRewardStatePath)
	}
	authPath := firstNonEmpty(
		s.AuthJSONPath,
		filepath.Join(tuttitypes.DefaultStateDir(), "account", "auth.json"),
	)
	return filepath.Join(filepath.Dir(authPath), registrationCreditsRewardStateFile)
}
