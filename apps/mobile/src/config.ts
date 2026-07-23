import { DEFAULT_APP_ID } from "@tutti-os/auth-bridge/shared";
import { NativeModules } from "react-native";

export const accountBaseURL = "https://tutti.sh/api/account";
export const accountAppID = DEFAULT_APP_ID;
export const controlPlaneBaseURL = "https://tutti.sh/api/desktop/v1";
export const mobileClientVersion = String(
  NativeModules.TuttiMobileSecurity?.clientVersion ?? "0.0.0"
);
