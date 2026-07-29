package providerregistry

// ResolveModelPlanProtocol returns the model API protocol declared by a
// migrated provider runtime. Providers without endpoint injection support are
// intentionally unresolved.
func ResolveModelPlanProtocol(value string) (ModelPlanProtocol, bool) {
	index, ok := providerDescriptorIndex[normalize(value)]
	if !ok {
		return "", false
	}
	protocol := migratedDescriptors[index].Runtime.Endpoint.ModelPlanProtocol
	return protocol, protocol != ""
}

// ResolveModelPlanModelAddressing returns the composer/settings addressing a
// migrated provider runtime declares for bound plan models. The empty value
// (raw plan model ids) resolves as unset.
func ResolveModelPlanModelAddressing(value string) (ModelPlanModelAddressing, bool) {
	index, ok := providerDescriptorIndex[normalize(value)]
	if !ok {
		return "", false
	}
	addressing := migratedDescriptors[index].Runtime.Endpoint.ModelPlanModelAddressing
	return addressing, addressing != ""
}

// ResolveModelPlanEndpointAdapter returns the transport adapter declared by a
// migrated provider runtime. Direct endpoint consumers intentionally resolve
// as unset.
func ResolveModelPlanEndpointAdapter(value string) (ModelPlanEndpointAdapter, bool) {
	index, ok := providerDescriptorIndex[normalize(value)]
	if !ok {
		return "", false
	}
	adapter := migratedDescriptors[index].Runtime.Endpoint.ModelPlanEndpointAdapter
	return adapter, adapter != ""
}
