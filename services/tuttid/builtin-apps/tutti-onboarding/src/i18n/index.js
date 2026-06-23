import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enOnboarding from "./locales/en-US/onboarding.json";
import zhOnboarding from "./locales/zh-CN/onboarding.json";

export const supportedLocales = ["en-US", "zh-CN"];

void i18n.use(initReactI18next).init({
  fallbackLng: "en-US",
  interpolation: {
    escapeValue: false
  },
  lng: "en-US",
  ns: ["onboarding"],
  defaultNS: "onboarding",
  resources: {
    "en-US": {
      onboarding: enOnboarding
    },
    "zh-CN": {
      onboarding: zhOnboarding
    }
  }
});

export default i18n;
