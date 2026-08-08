//go:build windows

package runtimecmd

import "golang.org/x/sys/windows/registry"

const windowsInternetSettingsKey = `Software\Microsoft\Windows\CurrentVersion\Internet Settings`

func readSystemProxyEnv() map[string]string {
	key, err := registry.OpenKey(registry.CURRENT_USER, windowsInternetSettingsKey, registry.QUERY_VALUE)
	if err != nil {
		return nil
	}
	defer key.Close()
	enabled, _, err := key.GetIntegerValue("ProxyEnable")
	if err != nil || enabled == 0 {
		return nil
	}
	server, _, err := key.GetStringValue("ProxyServer")
	if err != nil {
		return nil
	}
	override, _, _ := key.GetStringValue("ProxyOverride")
	return parseWindowsProxyServer(server, override)
}
