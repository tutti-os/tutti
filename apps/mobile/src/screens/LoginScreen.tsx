import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { t } from "../i18n";
import type { AccountSession } from "../native/mobileNative";
import { sendEmailCode, verifyEmailCode } from "../services/accountClient";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";

interface LoginScreenProps {
  onSignedIn(session: AccountSession): Promise<void>;
}

export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [step, setStep] = useState<"email" | "code">("email");

  const submit = async () => {
    setError(null);
    setPending(true);
    try {
      if (step === "email") {
        await sendEmailCode(email);
        setStep("code");
      } else {
        await onSignedIn(await verifyEmailCode(email, code));
      }
    } catch {
      setError(t("genericError"));
    } finally {
      setPending(false);
    }
  };

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
          <Text style={styles.label}>
            {t(step === "email" ? "email" : "code")}
          </Text>
          <TextInput
            autoCapitalize="none"
            autoComplete={step === "email" ? "email" : "one-time-code"}
            editable={!pending}
            inputMode={step === "email" ? "email" : "numeric"}
            keyboardType={step === "email" ? "email-address" : "number-pad"}
            onChangeText={step === "email" ? setEmail : setCode}
            onSubmitEditing={() => {
              if (!disabled) {
                void submit();
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
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <PrimaryButton
            disabled={disabled}
            label={t(step === "email" ? "loginAction" : "verifyAction")}
            loading={pending}
            onPress={() => void submit()}
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
