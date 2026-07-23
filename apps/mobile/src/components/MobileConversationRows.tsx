import type {
  WorkspaceAgentInteraction,
  WorkspaceAgentSessionMessage
} from "@tutti-os/client-tuttid-ts";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { PrimaryButton } from "./PrimaryButton";
import { t } from "../i18n";
import { theme } from "../theme";

export function MobileMessageRow({
  message
}: {
  message: WorkspaceAgentSessionMessage;
}) {
  const body = messageText(message);
  const user = message.role === "user";
  if (!body) {
    return null;
  }
  return (
    <View style={[styles.messageRow, user && styles.userMessageRow]}>
      <Text style={styles.messageRole}>
        {user
          ? t("you")
          : message.kind === "reasoning"
            ? t("reasoning")
            : t("agent")}
      </Text>
      <Text style={styles.messageBody}>{body}</Text>
      {message.status ? (
        <Text style={styles.messageStatus}>{message.status}</Text>
      ) : null}
    </View>
  );
}

interface MobileInteractionCardProps {
  interaction: WorkspaceAgentInteraction;
  onSubmit(input: {
    action?: string;
    optionId?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
}

export function MobileInteractionCard({
  interaction,
  onSubmit
}: MobileInteractionCardProps) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const input = interaction.input ?? {};
  const questions = useMemo(() => normalizeQuestions(input.questions), [input]);
  const options = normalizeOptions(input.options);
  const submit = async (value: Parameters<typeof onSubmit>[0]) => {
    setSubmitting(true);
    setFailed(false);
    try {
      await onSubmit(value);
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.interactionCard}>
      <Text style={styles.interactionKind}>
        {interaction.kind === "question"
          ? t("question")
          : interaction.kind === "plan"
            ? t("plan")
            : t("approval")}
      </Text>
      <Text style={styles.interactionTitle}>
        {interactionSummary(interaction)}
      </Text>
      {failed ? <Text style={styles.error}>{t("genericError")}</Text> : null}

      {interaction.kind === "question" ? (
        <>
          {questions.map((question) => {
            const selected = answers[question.id] ?? [];
            return (
              <View key={question.id} style={styles.question}>
                <Text style={styles.questionText}>{question.question}</Text>
                {question.options.length > 0 ? (
                  <View style={styles.optionList}>
                    {question.options.map((option) => {
                      const active = selected.includes(option);
                      return (
                        <Pressable
                          key={option}
                          onPress={() =>
                            setAnswers((current) => ({
                              ...current,
                              [question.id]: question.multiSelect
                                ? active
                                  ? selected.filter((value) => value !== option)
                                  : [...selected, option]
                                : [option]
                            }))
                          }
                          style={[
                            styles.option,
                            active && styles.optionSelected
                          ]}
                        >
                          <Text style={styles.optionText}>{option}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : (
                  <TextInput
                    multiline
                    onChangeText={(value) =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: value ? [value] : []
                      }))
                    }
                    placeholder={t("answerHint")}
                    placeholderTextColor={theme.color.muted}
                    style={styles.answerInput}
                    value={selected[0] ?? ""}
                  />
                )}
              </View>
            );
          })}
          <PrimaryButton
            disabled={questions.some(
              (question) => (answers[question.id]?.length ?? 0) === 0
            )}
            label={t("submit")}
            loading={submitting}
            onPress={() => {
              const answersByQuestionId = Object.fromEntries(
                questions.map((question) => {
                  const values = answers[question.id] ?? [];
                  return [
                    question.id,
                    question.multiSelect ? values : (values[0] ?? "")
                  ];
                })
              );
              void submit({
                action: "submit",
                payload: {
                  answers: Object.values(answersByQuestionId).map((value) =>
                    Array.isArray(value) ? value.join(", ") : value
                  ),
                  answersByQuestionId
                }
              });
            }}
          />
        </>
      ) : options.length > 0 ? (
        <View style={styles.actionList}>
          {options.map((option) => (
            <PrimaryButton
              key={option.id}
              disabled={submitting}
              label={option.label}
              onPress={() => void submit({ optionId: option.id })}
              secondary
            />
          ))}
        </View>
      ) : (
        <View style={styles.actionRow}>
          <PrimaryButton
            disabled={submitting}
            label={t("deny")}
            onPress={() => void submit({ action: "deny" })}
            secondary
            style={styles.actionButton}
          />
          <PrimaryButton
            disabled={submitting}
            label={t("allow")}
            loading={submitting}
            onPress={() => void submit({ action: "allow" })}
            style={styles.actionButton}
          />
        </View>
      )}
    </View>
  );
}

function messageText(message: WorkspaceAgentSessionMessage): string {
  const payload = message.payload ?? {};
  for (const value of [
    payload.text,
    payload.content,
    payload.message,
    payload.summary
  ]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  if (Array.isArray(payload.content)) {
    return payload.content
      .map((block) =>
        typeof block === "object" &&
        block !== null &&
        "text" in block &&
        typeof block.text === "string"
          ? block.text
          : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  if (message.kind.includes("tool")) {
    const name = typeof payload.name === "string" ? payload.name : t("tool");
    return `${name}${message.status ? ` · ${message.status}` : ""}`;
  }
  return "";
}

function interactionSummary(interaction: WorkspaceAgentInteraction): string {
  const input = interaction.input ?? {};
  for (const value of [
    input.displayPrompt,
    input.summary,
    input.title,
    input.question,
    input.prompt,
    input.text
  ]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return interaction.toolName?.trim() || t("pendingInteraction");
}

function normalizeOptions(
  value: unknown
): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const option = candidate as Record<string, unknown>;
    const id =
      typeof option.optionId === "string"
        ? option.optionId
        : typeof option.id === "string"
          ? option.id
          : "";
    if (!id.trim()) {
      return [];
    }
    const label =
      typeof option.label === "string"
        ? option.label
        : typeof option.name === "string"
          ? option.name
          : id;
    return [{ id: id.trim(), label: label.trim() || id.trim() }];
  });
}

function normalizeQuestions(value: unknown): Array<{
  id: string;
  multiSelect: boolean;
  options: string[];
  question: string;
}> {
  if (!Array.isArray(value) || value.length === 0) {
    return [
      {
        id: "response",
        multiSelect: false,
        options: [],
        question: t("question")
      }
    ];
  }
  return value.map((candidate, index) => {
    const question =
      candidate && typeof candidate === "object"
        ? (candidate as Record<string, unknown>)
        : {};
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (typeof option === "string") {
            return option.trim() ? [option.trim()] : [];
          }
          if (!option || typeof option !== "object") {
            return [];
          }
          const record = option as Record<string, unknown>;
          const label =
            typeof record.label === "string"
              ? record.label
              : typeof record.name === "string"
                ? record.name
                : "";
          return label.trim() ? [label.trim()] : [];
        })
      : [];
    return {
      id:
        typeof question.id === "string" && question.id.trim()
          ? question.id.trim()
          : `question-${index + 1}`,
      multiSelect: question.multiSelect === true,
      options,
      question:
        typeof question.question === "string" && question.question.trim()
          ? question.question.trim()
          : t("question")
    };
  });
}

const styles = StyleSheet.create({
  actionButton: { flex: 1 },
  actionList: { gap: theme.space.small, marginTop: theme.space.medium },
  actionRow: {
    flexDirection: "row",
    gap: theme.space.small,
    marginTop: theme.space.medium
  },
  answerInput: {
    borderColor: theme.color.border,
    borderRadius: theme.radius.medium,
    borderWidth: StyleSheet.hairlineWidth,
    color: theme.color.text,
    minHeight: 72,
    padding: theme.space.small
  },
  interactionCard: {
    backgroundColor: theme.color.panelRaised,
    borderColor: theme.color.accent,
    borderRadius: theme.radius.medium,
    borderWidth: StyleSheet.hairlineWidth,
    gap: theme.space.small,
    padding: theme.space.medium
  },
  error: { color: theme.color.danger, fontSize: 12 },
  interactionKind: {
    color: theme.color.accent,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase"
  },
  interactionTitle: {
    color: theme.color.text,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 21
  },
  messageBody: { color: theme.color.text, fontSize: 15, lineHeight: 23 },
  messageRole: {
    color: theme.color.accent,
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 7,
    textTransform: "uppercase"
  },
  messageRow: {
    backgroundColor: theme.color.panel,
    borderColor: theme.color.border,
    borderRadius: theme.radius.large,
    borderWidth: StyleSheet.hairlineWidth,
    padding: theme.space.medium
  },
  messageStatus: { color: theme.color.muted, fontSize: 11, marginTop: 8 },
  option: {
    borderColor: theme.color.border,
    borderRadius: theme.radius.medium,
    borderWidth: StyleSheet.hairlineWidth,
    padding: theme.space.small
  },
  optionList: { gap: 6 },
  optionSelected: { borderColor: theme.color.accent },
  optionText: { color: theme.color.text, fontSize: 14 },
  question: { gap: theme.space.small },
  questionText: { color: theme.color.textSecondary, fontSize: 14 },
  userMessageRow: {
    backgroundColor: theme.color.panelRaised,
    marginLeft: 32
  }
});
