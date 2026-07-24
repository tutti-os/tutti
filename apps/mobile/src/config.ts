import {
  DEFAULT_ACCOUNT_BASE_URL,
  DEFAULT_APP_ID,
  DEFAULT_AUTH_LOGIN_URL
} from "@tutti-os/auth-bridge/shared";
import { NativeModules } from "react-native";

export const accountBaseURL = DEFAULT_ACCOUNT_BASE_URL;
export const accountAppID = DEFAULT_APP_ID;
export const accountAuthLoginURL = DEFAULT_AUTH_LOGIN_URL;
export const controlPlaneBaseURL = "https://tutti.sh/api/desktop/v1";
export const mobileAuthCallbackURL = "tutti://auth/login";
export const mobileClientVersion = String(
  NativeModules.TuttiMobileSecurity?.clientVersion ?? "0.0.0"
);
