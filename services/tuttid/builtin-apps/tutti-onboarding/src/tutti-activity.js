let reportedUserActive = false;

function getTuttiActivityBridge() {
  if (typeof window === "undefined") return null;
  return window.tuttiExternal?.activity ?? null;
}

export function reportUserActive() {
  const reportActive = getTuttiActivityBridge()?.reportActive;
  if (typeof reportActive !== "function") return;
  try {
    void Promise.resolve(reportActive()).catch(() => {});
  } catch {
    // Activity reporting must not affect the app workflow.
  }
}

export function reportUserActiveOnce() {
  if (reportedUserActive) return;
  reportedUserActive = true;
  reportUserActive();
}
