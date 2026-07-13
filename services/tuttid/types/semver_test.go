package types

import "testing"

func TestNormalizeSemver(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		value     string
		want      string
		wantValid bool
	}{
		{name: "stable", value: "1.2.3", want: "v1.2.3", wantValid: true},
		{name: "prefixed", value: " v1.2.3-rc.1 ", want: "v1.2.3-rc.1", wantValid: true},
		{name: "empty", value: " ", want: "", wantValid: false},
		{name: "invalid", value: "latest", want: "vlatest", wantValid: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got, valid := NormalizeSemver(test.value)
			if got != test.want || valid != test.wantValid {
				t.Fatalf("NormalizeSemver(%q) = (%q, %v), want (%q, %v)", test.value, got, valid, test.want, test.wantValid)
			}
		})
	}
}
