package eventstream

func modelGovernanceTopicDefinitions() []TopicDefinition {
	return []TopicDefinition{
		{
			Name:               TopicAgentModelConfigurationChanged,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateAgentModelConfigurationChangedPayload,
			},
		},
		{
			Name:               TopicAgentAutomationRulesChanged,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateAgentAutomationRulesChangedPayload,
			},
		},
	}
}
