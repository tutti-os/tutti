package devicelink

type PathScope string

const (
	PathScopeLocalSubnet    PathScope = "local_subnet"
	PathScopePrivateNetwork PathScope = "private_network"
	PathScopePublicInternet PathScope = "public_internet"
)

func (s PathScope) Valid() bool {
	return s == PathScopeLocalSubnet || s == PathScopePrivateNetwork || s == PathScopePublicInternet
}
