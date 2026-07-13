package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func registerWorkspaceAppRoutes(mux *http.ServeMux, wrapper *tuttigenerated.ServerInterfaceWrapper) {
	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListWorkspaceApps(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/catalog/refresh", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.RefreshWorkspaceAppCatalog(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/start-enabled", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.StartEnabledWorkspaceApps(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/stop-all", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.StopAllWorkspaceApps(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/import", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ImportWorkspaceApp(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/load-local", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.LoadLocalWorkspaceApp(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/install", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.InstallWorkspaceApp(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/export", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ExportWorkspaceApp(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/icon", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ReplaceWorkspaceAppIcon(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/reload-local", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ReloadLocalWorkspaceApp(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/preferences/agent", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.GetWorkspaceAppAgentPreferences(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/agent-providers/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.GetWorkspaceAppAgentProviderStatuses(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/agent-providers/{provider}/composer-options", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.GetWorkspaceAppAgentProviderComposerOptions(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/references/list", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListWorkspaceAppReferences(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/references/search", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.SearchWorkspaceAppReferences(w, r)
	})

	registerWorkspaceAppUploadRoutes(mux, wrapper)

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/uninstall", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.UninstallWorkspaceApp(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.DeleteWorkspaceApp(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/launch", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.LaunchWorkspaceApp(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/retry", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.RetryWorkspaceApp(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/rollback", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.RollbackWorkspaceApp(w, r)
	})
}
