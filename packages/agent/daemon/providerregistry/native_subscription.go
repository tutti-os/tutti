package providerregistry

import "fmt"

// NativeSubscriptionTarget is the credential-free local runtime route used to
// validate one official subscription protocol.
type NativeSubscriptionTarget struct {
	ProviderID    string
	AgentTargetID string
}

// ResolveNativeSubscriptionTarget returns the registry-owned official
// subscription probe route. ValidateMigrated guarantees at most one route per
// protocol, so consumers never branch on provider identity.
func ResolveNativeSubscriptionTarget(protocol ModelPlanProtocol) (NativeSubscriptionTarget, bool) {
	for _, descriptor := range migratedDescriptors {
		endpoint := descriptor.Runtime.Endpoint
		if endpoint.NativeSubscription && endpoint.ModelPlanProtocol == protocol {
			return NativeSubscriptionTarget{
				ProviderID:    descriptor.Identity.ID,
				AgentTargetID: descriptor.Target.ID,
			}, true
		}
	}
	return NativeSubscriptionTarget{}, false
}

func validateNativeSubscriptions(descriptors []ProviderDescriptor) error {
	protocols := map[ModelPlanProtocol]string{}
	for _, descriptor := range descriptors {
		endpoint := descriptor.Runtime.Endpoint
		if !endpoint.NativeSubscription {
			continue
		}
		providerID := normalize(descriptor.Identity.ID)
		if endpoint.ModelPlanProtocol == "" {
			return fmt.Errorf("provider %q native subscription requires a model plan protocol", providerID)
		}
		if owner, exists := protocols[endpoint.ModelPlanProtocol]; exists {
			return fmt.Errorf("native subscription protocol %q is shared by %q and %q", endpoint.ModelPlanProtocol, owner, providerID)
		}
		protocols[endpoint.ModelPlanProtocol] = providerID
	}
	return nil
}
