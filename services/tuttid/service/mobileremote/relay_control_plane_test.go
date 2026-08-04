package mobileremote

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
)

func TestSplitControlPlaneURL(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		raw    string
		base   string
		prefix string
		valid  bool
	}{
		{
			name:   "default",
			raw:    "",
			base:   "https://tutti.sh",
			prefix: "/api/desktop/v1",
			valid:  true,
		},
		{
			name:   "explicit origin",
			raw:    "https://control.example.test",
			base:   "https://control.example.test",
			prefix: "/v1",
			valid:  true,
		},
		{
			name:   "explicit api prefix",
			raw:    "https://control.example.test/api/desktop/v1/",
			base:   "https://control.example.test",
			prefix: "/api/desktop/v1",
			valid:  true,
		},
		{name: "query", raw: "https://control.example.test/v1?token=secret"},
		{name: "userinfo", raw: "https://user:pass@control.example.test/v1"},
		{name: "scheme", raw: "ftp://control.example.test/v1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			base, prefix, err := splitControlPlaneURL(test.raw)
			if !test.valid {
				if err == nil {
					t.Fatalf("splitControlPlaneURL(%q) unexpectedly succeeded", test.raw)
				}
				return
			}
			if err != nil || base != test.base || prefix != test.prefix {
				t.Fatalf("splitControlPlaneURL(%q) = (%q, %q, %v), want (%q, %q)", test.raw, base, prefix, err, test.base, test.prefix)
			}
		})
	}
}

func TestDeviceAuthorityIdentitySourceValidatesAndCopiesIdentity(t *testing.T) {
	t.Parallel()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	store := &stubIdentityStore{identity: mobileremotebiz.DeviceIdentity{
		DeviceID: "runtime-1", PrivateKey: privateKey, PublicKey: publicKey,
	}}
	source := deviceAuthorityIdentitySource{store: store}
	identity, err := source.Identity(context.Background(), "runtime-1")
	if err != nil {
		t.Fatal(err)
	}
	if identity.KeyID == "" || !bytes.Equal(identity.Signer.Public().(ed25519.PublicKey), publicKey) {
		t.Fatalf("identity = %#v, want matching public key and key id", identity)
	}
	identity.Signer.(ed25519.PrivateKey)[0] ^= 0xff
	if privateKey[0] == identity.Signer.(ed25519.PrivateKey)[0] {
		t.Fatal("identity source returned the store's private-key backing array")
	}
}
