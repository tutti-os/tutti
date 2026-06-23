import electron from "electron";
import type {
  AppUpdateChannel,
  AppUpdatePolicy,
  AppUpdateState,
  ConfigureAppUpdatesInput
} from "../../shared/contracts/ipc.ts";
import type { AppUpdateService } from "./appUpdateService.ts";

const { app } = electron;
const disabledUpdateMessage = "Application updates are disabled in this build.";

function createDisabledState(input: {
  channel: AppUpdateChannel;
  currentVersion: string;
  policy: AppUpdatePolicy;
}): AppUpdateState {
  return {
    channel: input.channel,
    checkedAt: null,
    currentVersion: input.currentVersion,
    downloadedBytes: null,
    downloadPercent: null,
    latestVersion: null,
    message: disabledUpdateMessage,
    policy: input.policy,
    releaseDate: null,
    releaseName: null,
    releaseNotesUrl: null,
    status: "unsupported",
    totalBytes: null
  };
}

export function createDisabledAppUpdateService(): AppUpdateService {
  const currentVersion = app?.getVersion?.() ?? "0.0.0";
  let state = createDisabledState({
    channel: "stable",
    currentVersion,
    policy: "off"
  });
  const listeners = new Set<
    (state: AppUpdateState, previousState: AppUpdateState) => void
  >();

  const applyState = (nextState: AppUpdateState): AppUpdateState => {
    const previousState = state;
    state = nextState;
    for (const listener of listeners) {
      listener(state, previousState);
    }
    return state;
  };

  return {
    checkForUpdates() {
      return Promise.resolve(state);
    },
    configure(input: ConfigureAppUpdatesInput) {
      return Promise.resolve(
        applyState(
          createDisabledState({
            channel: input.channel ?? state.channel,
            currentVersion,
            policy: input.policy
          })
        )
      );
    },
    dispose() {
      listeners.clear();
    },
    downloadUpdate() {
      return Promise.resolve(state);
    },
    getState() {
      return state;
    },
    installUpdate() {
      return Promise.resolve();
    },
    onStateChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
