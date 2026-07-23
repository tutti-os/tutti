import { NativeModules } from "react-native";

export const accountBaseURL = "https://tutti.sh/api/account";
export const accountAppID = "nextop";
export const controlPlaneBaseURL = "https://tutti.sh/api/desktop/v1";
export const mobileClientVersion = String(
  NativeModules.TuttiMobileSecurity?.clientVersion ?? "0.0.0"
);
