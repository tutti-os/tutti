package api

func stringPtrValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
