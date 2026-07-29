import type { AgentConversationVM } from "@tutti-os/agent-gui/conversation-projection";
import { type NativeTheme, useNativeTheme } from "@tutti-os/ui-system/native";
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View
} from "react-native";
import { t } from "../i18n";
import type { WorkspaceMediaSnapshot } from "../services/workspaceMediaService";

type ConversationImage = NonNullable<
  Extract<
    AgentConversationVM["rows"][number],
    { kind: "message" }
  >["messages"][number]["images"]
>[number];

export function MobileConversationImages({
  images,
  media
}: {
  images: readonly ConversationImage[];
  media: WorkspaceMediaSnapshot;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [preview, setPreview] = useState<string | null>(null);
  const loading = new Set(media.loadingImageIds);

  return (
    <>
      <View style={styles.grid}>
        {images.map((image) => {
          const source = media.sourcesByImageId[image.id];
          return (
            <Pressable
              disabled={!source}
              key={image.id}
              onPress={() => setPreview(source)}
              style={({ pressed }) => [
                styles.thumbnail,
                pressed && styles.pressed
              ]}
            >
              {source ? (
                <Image
                  accessibilityLabel={image.name?.trim() || t("image")}
                  resizeMode="cover"
                  source={{ uri: source }}
                  style={styles.thumbnailImage}
                />
              ) : loading.has(image.id) ? (
                <ActivityIndicator color={theme.color.accent} />
              ) : (
                <Text style={styles.unavailable}>{t("imageUnavailable")}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
      <Modal
        animationType="fade"
        onRequestClose={() => setPreview(null)}
        transparent
        visible={preview !== null}
      >
        <View style={styles.previewBackdrop}>
          <Pressable
            accessibilityLabel={t("closeImagePreview")}
            accessibilityRole="button"
            onPress={() => setPreview(null)}
            style={styles.previewClose}
          >
            <Text style={styles.previewCloseText}>×</Text>
          </Pressable>
          {preview ? (
            <Image
              accessibilityLabel={t("imagePreview")}
              resizeMode="contain"
              source={{ uri: preview }}
              style={styles.previewImage}
            />
          ) : null}
        </View>
      </Modal>
    </>
  );
}

export function MobileGeneratedImage({
  prompt,
  uri
}: {
  prompt: string | null;
  uri: string;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [preview, setPreview] = useState(false);
  const source = renderableGeneratedImageSource(uri);

  return (
    <>
      <Pressable
        disabled={!source}
        onPress={() => setPreview(true)}
        style={({ pressed }) => [
          styles.generatedImage,
          pressed && styles.pressed
        ]}
      >
        {source ? (
          <Image
            accessibilityLabel={prompt?.trim() || t("generatedImage")}
            resizeMode="contain"
            source={{ uri: source }}
            style={styles.generatedImageContent}
          />
        ) : (
          <>
            <Text style={styles.generatedImageTitle}>
              {t("generatedImage")}
            </Text>
            {prompt?.trim() ? (
              <Text numberOfLines={2} style={styles.generatedImagePrompt}>
                {prompt}
              </Text>
            ) : null}
          </>
        )}
      </Pressable>
      <Modal
        animationType="fade"
        onRequestClose={() => setPreview(false)}
        transparent
        visible={preview}
      >
        <View style={styles.previewBackdrop}>
          <Pressable
            accessibilityLabel={t("closeImagePreview")}
            accessibilityRole="button"
            onPress={() => setPreview(false)}
            style={styles.previewClose}
          >
            <Text style={styles.previewCloseText}>×</Text>
          </Pressable>
          {source ? (
            <Image
              accessibilityLabel={t("imagePreview")}
              resizeMode="contain"
              source={{ uri: source }}
              style={styles.previewImage}
            />
          ) : null}
        </View>
      </Modal>
    </>
  );
}

function renderableGeneratedImageSource(uri: string): string | null {
  const source = uri.trim();
  return /^(?:data:image\/|https?:\/\/)/i.test(source) ? source : null;
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    generatedImage: {
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      gap: theme.space.small,
      minHeight: 112,
      overflow: "hidden",
      padding: theme.space.medium
    },
    generatedImageContent: { height: 240, width: "100%" },
    generatedImagePrompt: {
      color: theme.color.textSecondary,
      fontSize: 14
    },
    generatedImageTitle: {
      color: theme.color.text,
      fontSize: 14,
      fontWeight: "700"
    },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.small },
    pressed: { opacity: 0.75 },
    previewBackdrop: {
      alignItems: "center",
      backgroundColor: theme.color.scrimStrong,
      flex: 1,
      justifyContent: "center",
      padding: theme.space.large
    },
    previewClose: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      position: "absolute",
      right: theme.space.medium,
      top: theme.space.large,
      width: 44,
      zIndex: 1
    },
    previewCloseText: {
      color: theme.color.text,
      fontSize: 34,
      lineHeight: 36
    },
    previewImage: { height: "88%", width: "100%" },
    thumbnail: {
      alignItems: "center",
      backgroundColor: theme.color.background,
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      height: 112,
      justifyContent: "center",
      overflow: "hidden",
      width: 112
    },
    thumbnailImage: { height: "100%", width: "100%" },
    unavailable: {
      color: theme.color.muted,
      fontSize: 11,
      padding: theme.space.small,
      textAlign: "center"
    }
  });
}
