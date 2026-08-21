package eventstream

func agentSideTopicDefinition() TopicDefinition {
	return TopicDefinition{
		Name:               TopicAgentSideUpdated,
		ClientCanPublish:   false,
		ClientCanSubscribe: true,
		Version:            1,
		directions:         []Direction{DirectionServerToClient},
		validators: map[Direction]PayloadValidator{
			DirectionServerToClient: validateAgentSideUpdatedPayload,
		},
	}
}
