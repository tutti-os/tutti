import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { t } from "../i18n";
import type { LoginSnapshot } from "../services/loginService";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";

interface LoginScreenViewProps {
  model: LoginSnapshot;
  onCodeChange(value: string): void;
  onEmailChange(value: string): void;
  onSubmitEmail(): void;
  onSubmitGitHub(): void;
}

export function LoginScreenView({
  model,
  onCodeChange,
  onEmailChange,
  onSubmitEmail,
  onSubmitGitHub
}: LoginScreenViewProps) {
  const { code, email, errorCode, pending, step } = model;
  const disabled =
    step === "email"
      ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
      : code.trim().length < 4;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.root}
    >
      <View style={styles.brand}>
        <View style={styles.mark}>
          <Text style={styles.markText}>T</Text>
        </View>
        <Text style={styles.appName}>{t("appName")}</Text>
      </View>
      <View style={styles.content}>
        <Text style={styles.eyebrow}>{t("welcome")}</Text>
        <Text style={styles.title}>{t("loginTitle")}</Text>
        <Text style={styles.subtitle}>{t("loginSubtitle")}</Text>

        <View style={styles.form}>
          <PrimaryButton
            disabled={pending !== null}
            label={t("githubLoginAction")}
            loading={pending === "github"}
            onPress={onSubmitGitHub}
          />
          <View style={styles.alternative}>
            <View style={styles.divider} />
            <Text style={styles.alternativeText}>{t("loginAlternative")}</Text>
            <View style={styles.divider} />
          </View>
          <Text style={styles.label}>
            {t(step === "email" ? "email" : "code")}
          </Text>
          <TextInput
            autoCapitalize="none"
            autoComplete={step === "email" ? "email" : "one-time-code"}
            editable={pending === null}
            inputMode={step === "email" ? "email" : "numeric"}
            keyboardType={step === "email" ? "email-address" : "number-pad"}
            onChangeText={step === "email" ? onEmailChange : onCodeChange}
            onSubmitEditing={() => {
              if (!disabled && pending === null) {
                onSubmitEmail();
              }
            }}
            placeholder={t(step === "email" ? "emailHint" : "codeHint")}
            placeholderTextColor={theme.color.muted}
            style={styles.input}
            value={step === "email" ? email : code}
          />
          {step === "code" ? (
            <Text style={styles.hint}>{t("emailSent")}</Text>
          ) : null}
          {errorCode === "request_failed" ? (
            <Text style={styles.error}>{t("genericError")}</Text>
          ) : null}
          <PrimaryButton
            disabled={disabled || pending !== null}
            label={t(step === "email" ? "loginAction" : "verifyAction")}
            loading={pending === "email"}
            onPress={onSubmitEmail}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  appName: {
    color: theme.color.text,
    fontSize: 18,
    fontWeight: "700"
  },
  alternative: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.space.small,
    marginVertical: theme.space.small
  },
  alternativeText: {
    color: theme.color.muted,
    fontSize: 12
  },
  brand: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: theme.space.large,
    paddingTop: theme.space.large
  },
  content: {
    flex: 1,
    justifyContent: "center",
    padding: theme.space.large
  },
  divider: {
    backgroundColor: theme.color.border,
    flex: 1,
    height: StyleSheet.hairlineWidth
  },
  error: {
    color: theme.color.danger,
    fontSize: 13,
    lineHeight: 19
  },
  eyebrow: {
    color: theme.color.accent,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase"
  },
  form: {
    gap: theme.space.small,
    marginTop: theme.space.xlarge
  },
  hint: {
    color: theme.color.textSecondary,
    fontSize: 13,
    lineHeight: 19
  },
  input: {
    backgroundColor: theme.color.panel,
    borderColor: theme.color.border,
    borderRadius: theme.radius.medium,
    borderWidth: 1,
    color: theme.color.text,
    fontSize: 16,
    height: 54,
    marginBottom: 4,
    paddingHorizontal: theme.space.medium
  },
  label: {
    color: theme.color.textSecondary,
    fontSize: 13,
    fontWeight: "600"
  },
  mark: {
    alignItems: "center",
    backgroundColor: theme.color.accent,
    borderRadius: 9,
    height: 32,
    justifyContent: "center",
    width: 32
  },
  markText: {
    color: theme.color.background,
    fontSize: 17,
    fontWeight: "900"
  },
  root: {
    backgroundColor: theme.color.background,
    flex: 1
  },
  subtitle: {
    color: theme.color.textSecondary,
    fontSize: 15,
    lineHeight: 23,
    marginTop: 12,
    maxWidth: 420
  },
  title: {
    color: theme.color.text,
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: -1,
    lineHeight: 41,
    marginTop: 8
  }
});
