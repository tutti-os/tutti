package workspace

import (
	"reflect"
	"testing"
)

func TestAppendTerminalUTF8LocaleFallback(t *testing.T) {
	tests := []struct {
		name string
		env  []string
		goos string
		want []string
	}{
		{
			name: "darwin adds fallback when locale is missing",
			env:  []string{"PATH=/usr/bin:/bin"},
			goos: "darwin",
			want: []string{"PATH=/usr/bin:/bin", "LC_CTYPE=UTF-8"},
		},
		{
			name: "darwin replaces effectively empty locale",
			env: []string{
				"LANG=",
				"LC_CTYPE=en_US.UTF-8",
				"LC_CTYPE=",
				"LC_ALL=",
			},
			goos: "darwin",
			want: []string{
				"LANG=",
				"LC_CTYPE=en_US.UTF-8",
				"LC_CTYPE=",
				"LC_ALL=",
				"LC_CTYPE=UTF-8",
			},
		},
		{
			name: "darwin preserves explicit lang",
			env:  []string{"LANG=zh_CN.UTF-8"},
			goos: "darwin",
			want: []string{"LANG=zh_CN.UTF-8"},
		},
		{
			name: "darwin preserves explicit lc ctype",
			env:  []string{"LC_CTYPE=C"},
			goos: "darwin",
			want: []string{"LC_CTYPE=C"},
		},
		{
			name: "darwin preserves explicit lc all",
			env:  []string{"LC_ALL=C"},
			goos: "darwin",
			want: []string{"LC_ALL=C"},
		},
		{
			name: "other platforms keep environment unchanged",
			env:  []string{"PATH=/usr/bin:/bin"},
			goos: "linux",
			want: []string{"PATH=/usr/bin:/bin"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := appendTerminalUTF8LocaleFallback(tt.env, tt.goos)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("appendTerminalUTF8LocaleFallback(%#v, %q) = %#v, want %#v", tt.env, tt.goos, got, tt.want)
			}
		})
	}
}
