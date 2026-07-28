import type { AgentActivityInteraction } from "@tutti-os/agent-activity-core";
import {
  buildAskUserAnswerPayload,
  readOwnAnswer,
  writeOwnAnswer
} from "@tutti-os/agent-gui/agent-conversation/interactive-answer";
import {
  projectAgentConversationPromptFromInteraction,
  type AgentConversationPromptVM
} from "@tutti-os/agent-gui/conversation-projection";
import { type NativeTheme, useNativeTheme } from "@tutti-os/ui-system/native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { t } from "../i18n";
import { PrimaryButton } from "./PrimaryButton";

interface MobileInteractionCardProps {
  failed: boolean;
  interaction: AgentActivityInteraction;
  onRetry(): void;
  onSubmit(input: {
    action?: string;
    optionId?: string;
    payload?: Record<string, unknown>;
  }): void;
  runtimeAvailable: boolean;
  submitting: boolean;
}

export function MobileInteractionCard({
  failed,
  interaction,
  onRetry,
  onSubmit,
  runtimeAvailable,
  submitting
}: MobileInteractionCardProps) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [planFeedback, setPlanFeedback] = useState("");
  const interactionIdentity = `${interaction.agentSessionId}:${interaction.turnId}:${interaction.requestId}`;
  const prompt = useMemo(
    () => projectAgentConversationPromptFromInteraction(interaction),
    [interaction]
  );
  const questions = prompt?.kind === "ask-user" ? prompt.questions : [];
  const options = prompt?.kind === "approval" ? prompt.options : [];
  const submit = (value: Parameters<typeof onSubmit>[0]) => {
    if (submitting || !runtimeAvailable) return;
    onSubmit(value);
  };

  useEffect(() => {
    setAnswers({});
    setPlanFeedback("");
  }, [interactionIdentity]);

  if (failed) {
    return (
      <View style={styles.interactionCard}>
        <Text style={styles.interactionKind}>
          {prompt?.kind === "ask-user"
            ? t("question")
            : prompt?.kind === "exit-plan"
              ? t("plan")
              : t("approval")}
        </Text>
        <Text style={styles.interactionTitle}>
          {prompt?.title || interactionSummary(interaction)}
        </Text>
        <Text style={styles.error}>{t("genericError")}</Text>
        <PrimaryButton
          disabled={!runtimeAvailable}
          label={t("retry")}
          onPress={onRetry}
        />
      </View>
    );
  }

  return (
    <View style={styles.interactionCard}>
      <Text style={styles.interactionKind}>
        {prompt?.kind === "ask-user"
          ? t("question")
          : prompt?.kind === "exit-plan"
            ? t("plan")
            : t("approval")}
      </Text>
      <Text style={styles.interactionTitle}>
        {prompt?.title || interactionSummary(interaction)}
      </Text>
      {prompt?.kind === "ask-user" ? (
        <>
          {questions.map((question) => {
            const selected = readOwnAnswer(answers, question.id, []);
            return (
              <View key={question.id} style={styles.question}>
                <Text style={styles.questionText}>
                  {question.question || question.header || t("question")}
                </Text>
                {question.options.length > 0 ? (
                  <View style={styles.optionList}>
                    {question.options.map((option) => {
                      const active = selected.includes(option.label);
                      return (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          disabled={submitting || !runtimeAvailable}
                          key={`${question.id}:${option.label}`}
                          onPress={() => {
                            setAnswers((current) => {
                              const updated = { ...current };
                              writeOwnAnswer(
                                updated,
                                question.id,
                                question.multiSelect
                                  ? active
                                    ? selected.filter(
                                        (value) => value !== option.label
                                      )
                                    : [...selected, option.label]
                                  : [option.label]
                              );
                              return updated;
                            });
                          }}
                          style={[
                            styles.option,
                            active && styles.optionSelected
                          ]}
                        >
                          <Text style={styles.optionText}>{option.label}</Text>
                          {option.description ? (
                            <Text style={styles.optionDescription}>
                              {option.description}
                            </Text>
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </View>
                ) : (
                  <TextInput
                    editable={!submitting && runtimeAvailable}
                    multiline
                    onChangeText={(value) => {
                      setAnswers((current) => {
                        const updated = { ...current };
                        writeOwnAnswer(
                          updated,
                          question.id,
                          value ? [value] : []
                        );
                        return updated;
                      });
                    }}
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
            disabled={
              submitting ||
              !runtimeAvailable ||
              questions.some(
                (question) =>
                  readOwnAnswer(answers, question.id, []).length === 0
              )
            }
            label={t("submit")}
            loading={submitting}
            onPress={() => {
              const answersByQuestionId: Record<string, string | string[]> = {};
              for (const question of questions) {
                const values = readOwnAnswer(answers, question.id, []);
                writeOwnAnswer(
                  answersByQuestionId,
                  question.id,
                  question.multiSelect ? values : (values[0] ?? "")
                );
              }
              submit({
                action: "submit",
                payload: {
                  ...buildAskUserAnswerPayload(answersByQuestionId)
                }
              });
            }}
          />
        </>
      ) : prompt?.kind === "approval" ? (
        <View style={styles.actionList}>
          {options.map((option) => (
            <PrimaryButton
              disabled={submitting || !runtimeAvailable}
              key={option.id}
              label={option.label}
              onPress={() => submit({ optionId: option.id })}
              secondary
            />
          ))}
        </View>
      ) : prompt?.kind === "exit-plan" && prompt.options.length > 0 ? (
        <MobileExitPlanActions
          feedback={planFeedback}
          onFeedbackChange={setPlanFeedback}
          onSubmit={submit}
          prompt={prompt}
          runtimeAvailable={runtimeAvailable}
          submitting={submitting}
        />
      ) : (
        <Text style={styles.unsupportedInteraction}>
          {t("pendingInteractionDesktop")}
        </Text>
      )}
    </View>
  );
}

function MobileExitPlanActions({
  feedback,
  onFeedbackChange,
  onSubmit,
  prompt,
  runtimeAvailable,
  submitting
}: {
  feedback: string;
  onFeedbackChange(value: string): void;
  onSubmit(value: {
    action?: string;
    optionId?: string;
    payload?: Record<string, unknown>;
  }): void;
  prompt: Extract<AgentConversationPromptVM, { kind: "exit-plan" }>;
  runtimeAvailable: boolean;
  submitting: boolean;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const trimmedFeedback = feedback.trim();

  return (
    <View style={styles.actionList}>
      <Text style={styles.questionText}>{t("planPermissionQuestion")}</Text>
      {prompt.options.map((mode) => (
        <Pressable
          accessibilityRole="button"
          disabled={submitting || !runtimeAvailable}
          key={mode.id}
          onPress={() => onSubmit({ action: "allow", optionId: mode.id })}
          style={styles.option}
        >
          <Text style={styles.optionText}>{mode.label}</Text>
          {mode.description ? (
            <Text style={styles.optionDescription}>{mode.description}</Text>
          ) : null}
        </Pressable>
      ))}
      <TextInput
        editable={!submitting && runtimeAvailable}
        multiline
        onChangeText={onFeedbackChange}
        placeholder={t("planFeedbackHint")}
        placeholderTextColor={theme.color.muted}
        style={styles.answerInput}
        value={feedback}
      />
      <PrimaryButton
        disabled={submitting || !runtimeAvailable}
        label={trimmedFeedback ? t("sendPlanFeedback") : t("keepPlanning")}
        onPress={() =>
          onSubmit({
            action: "deny",
            ...(prompt.keepPlanningOptionId
              ? { optionId: prompt.keepPlanningOptionId }
              : {}),
            ...(trimmedFeedback
              ? { payload: { denyMessage: trimmedFeedback } }
              : {})
          })
        }
        secondary
      />
    </View>
  );
}

function interactionSummary(interaction: AgentActivityInteraction): string {
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

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    actionList: { gap: theme.space.small, marginTop: theme.space.medium },
    answerInput: {
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      color: theme.color.text,
      minHeight: 72,
      padding: theme.space.small
    },
    error: { color: theme.color.danger, fontSize: 12 },
    interactionCard: {
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.accent,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      gap: theme.space.small,
      padding: theme.space.medium
    },
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
    option: {
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      padding: theme.space.small
    },
    optionDescription: { color: theme.color.muted, fontSize: 12, marginTop: 3 },
    optionList: { gap: 6 },
    optionSelected: { borderColor: theme.color.accent },
    optionText: { color: theme.color.text, fontSize: 14 },
    question: { gap: theme.space.small },
    questionText: { color: theme.color.textSecondary, fontSize: 14 },
    unsupportedInteraction: {
      color: theme.color.textSecondary,
      fontSize: 13,
      lineHeight: 19
    }
  });
}
