package eventstream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	userpresenceservice "github.com/tutti-os/tutti/services/tuttid/service/userpresence"
)

func accountUserPresenceTopicDefinition() TopicDefinition {
	return TopicDefinition{
		Name: TopicAccountUserPresenceUpdated, ClientCanPublish: false, ClientCanSubscribe: true,
		Version: 1, directions: []Direction{DirectionServerToClient},
		validators: map[Direction]PayloadValidator{DirectionServerToClient: validateAccountUserPresencePayload},
	}
}

func validateAccountUserPresencePayload(payload []byte) error {
	var update struct {
		UserID              string `json:"userId"`
		Status              string `json:"status"`
		Availability        string `json:"availability"`
		PresenceRevision    string `json:"presenceRevision"`
		AuthorityGeneration string `json:"authorityGeneration"`
	}
	if err := json.Unmarshal(payload, &update); err != nil {
		return err
	}
	if strings.TrimSpace(update.UserID) == "" ||
		(update.Status != string(userpresenceservice.StatusOnline) && update.Status != string(userpresenceservice.StatusOffline)) ||
		strings.TrimSpace(update.Availability) == "" {
		return errors.New("account user presence payload is invalid")
	}
	return nil
}

type UserPresencePublisher struct {
	Service *Service
}

func (publisher UserPresencePublisher) PublishUserPresence(ctx context.Context, view userpresenceservice.PresenceView) error {
	if publisher.Service == nil {
		return errors.New("user presence event stream is unavailable")
	}
	payload, err := json.Marshal(view)
	if err != nil {
		return fmt.Errorf("encode user presence event: %w", err)
	}
	if err := publisher.Service.PublishFromServer(ctx, TopicAccountUserPresenceUpdated, payload); err != nil {
		return fmt.Errorf("publish %s: %w", TopicAccountUserPresenceUpdated, err)
	}
	return nil
}
