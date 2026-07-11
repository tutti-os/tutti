package agentstatus

import "testing"

func TestCompareCodexVersions(t *testing.T) {
	cases := []struct {
		name string
		a    string
		b    string
		want int
		ok   bool
	}{
		{"equal", "0.5.0", "0.5.0", 0, true},
		{"patch less", "0.4.9", "0.5.0", -1, true},
		{"patch greater", "0.5.1", "0.5.0", 1, true},
		{"minor numeric not lexical", "0.10.0", "0.9.0", 1, true},
		{"major greater", "1.0.0", "0.5.0", 1, true},
		{"leading v parsed", "v0.5.0", "0.5.0", 0, true},
		{"prerelease less than release", "0.5.0-rc.1", "0.5.0", -1, true},
		{"missing patch defaults zero", "0.5", "0.5.0", 0, true},
		{"empty unparseable", "", "0.5.0", 0, false},
		{"garbage unparseable", "abc", "0.5.0", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := compareCodexVersions(tc.a, tc.b)
			if ok != tc.ok {
				t.Fatalf("compareCodexVersions(%q,%q) ok=%v, want %v", tc.a, tc.b, ok, tc.ok)
			}
			if ok && got != tc.want {
				t.Fatalf("compareCodexVersions(%q,%q)=%d, want %d", tc.a, tc.b, got, tc.want)
			}
		})
	}
}

func TestCodexVersionMeetsMinimum(t *testing.T) {
	cases := []struct {
		name    string
		version string
		want    bool
	}{
		{"equal to minimum", MinSupportedCodexVersion, true},
		{"above minimum", "999.0.0", true},
		{"below minimum", "0.0.1", false},
		{"empty rejected as unknown", "", false},
		{"unparseable rejected as unknown", "garbage", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := codexVersionMeetsMinimum(tc.version); got != tc.want {
				t.Fatalf("codexVersionMeetsMinimum(%q)=%v, want %v", tc.version, got, tc.want)
			}
		})
	}
}
