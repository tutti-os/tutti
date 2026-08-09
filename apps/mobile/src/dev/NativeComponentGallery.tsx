import {
  NativeAvatar,
  NativeButton,
  NativeControlGlyph,
  NativeIconButton,
  NativeListRow,
  NativeProgressBar,
  NativeSheet,
  type NativeTheme,
  useNativeTheme
} from "@tutti-os/ui-system/native";
import { useState, type ReactNode } from "react";
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import tuttiMark from "../assets/tutti-mark.png";
import { t } from "../i18n";

/** Native-only visual review surface for UI System primitive promotion. */
export function NativeComponentGallery({ onClose }: { onClose(): void }) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [sheetOpen, setSheetOpen] = useState(false);
  const previewImageURI = Image.resolveAssetSource(tuttiMark).uri;

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>{t("nativeGallery")}</Text>
            <Text style={styles.description}>
              {t("nativeGalleryDescription")}
            </Text>
          </View>
          <NativeIconButton
            accessibilityLabel={t("nativeGalleryClose")}
            icon={<Text style={styles.closeIcon}>×</Text>}
            onPress={onClose}
          />
        </View>

        <GallerySection title="native-button">
          <NativeButton label={t("newSession")} onPress={() => undefined} />
          <NativeButton
            label={t("cancel")}
            onPress={() => undefined}
            variant="secondary"
          />
          <NativeButton
            label={t("deleteSession")}
            onPress={() => undefined}
            variant="destructive"
          />
          <NativeButton
            label={t("deleteSession")}
            onPress={() => undefined}
            variant="destructiveGhost"
          />
          <NativeButton
            label={t("cancel")}
            onPress={() => undefined}
            variant="ghost"
          />
          <NativeButton disabled label={t("save")} onPress={() => undefined} />
          <NativeButton
            label={t("loading")}
            loading
            onPress={() => undefined}
          />
        </GallerySection>

        <GallerySection title="native-avatar">
          <View style={styles.inline}>
            <GalleryState label="fallback">
              <NativeAvatar label="Tutti" size="compact" />
            </GalleryState>
            <GalleryState label="image">
              <NativeAvatar label="Tutti" src={previewImageURI} />
            </GalleryState>
            <GalleryState label="loading">
              <NativeAvatar label="Tutti" loading size="large" />
            </GalleryState>
            <GalleryState label="error">
              <NativeAvatar
                label="Broken image"
                size="large"
                src="invalid://native-avatar-preview"
              />
            </GalleryState>
          </View>
        </GallerySection>

        <GallerySection title="native-icon-button">
          <View style={styles.inline}>
            <NativeIconButton
              accessibilityLabel={t("nativeGalleryClose")}
              icon={<Text style={styles.closeIcon}>×</Text>}
              onPress={() => undefined}
              variant="secondary"
            />
            <NativeIconButton
              accessibilityLabel={t("moreActions")}
              icon={<Text style={styles.moreIcon}>⋯</Text>}
              onPress={() => undefined}
            />
            <NativeIconButton
              accessibilityLabel={t("moreActions")}
              disabled
              icon={<Text style={styles.moreIcon}>⋯</Text>}
              onPress={() => undefined}
            />
          </View>
        </GallerySection>

        <GallerySection title="native-control-glyph">
          <View style={styles.glyphGrid}>
            {(["add", "back", "send", "status", "stop"] as const).map(
              (variant) => (
                <View key={variant} style={styles.glyphPreview}>
                  <NativeControlGlyph
                    color={theme.color.text}
                    variant={variant}
                  />
                  <Text style={styles.galleryStateLabel}>{variant}</Text>
                </View>
              )
            )}
            {(["down", "left", "right", "up"] as const).map((direction) => (
              <View key={direction} style={styles.glyphPreview}>
                <NativeControlGlyph
                  color={theme.color.text}
                  direction={direction}
                  variant="chevron"
                />
                <Text style={styles.galleryStateLabel}>{direction}</Text>
              </View>
            ))}
          </View>
        </GallerySection>

        <GallerySection title="native-list-row">
          <NativeListRow
            description={t("recentSessions")}
            onPress={() => undefined}
            title={t("untitledSession")}
            trailing={<Text style={styles.trailing}>›</Text>}
          />
          <NativeListRow disabled title={t("emptySessions")} />
          <NativeListRow
            description={t("needsAttention")}
            onPress={() => undefined}
            selected
            title={t("newSession")}
            trailing={<Text style={styles.trailing}>›</Text>}
          />
        </GallerySection>

        <GallerySection title="native-progress-bar">
          <GalleryState label="determinate">
            <NativeProgressBar accessibilityLabel="64 percent" value={0.64} />
          </GalleryState>
          <GalleryState label="indeterminate">
            <NativeProgressBar
              accessibilityLabel="Indeterminate progress"
              value={null}
            />
          </GalleryState>
        </GallerySection>

        <GallerySection title="native-sheet">
          <NativeButton
            label={t("nativeGallerySheet")}
            onPress={() => setSheetOpen(true)}
            variant="secondary"
          />
        </GallerySection>
      </ScrollView>

      <NativeSheet
        closeAccessibilityLabel={t("closeSheet")}
        height="50%"
        onOpenChange={setSheetOpen}
        open={sheetOpen}
      >
        <View style={styles.sheetContent}>
          <Text style={styles.sheetTitle}>{t("nativeGallerySheet")}</Text>
          <Text style={styles.description}>{t("nativeGallerySheetBody")}</Text>
          <TextInput
            placeholder={t("messageHint")}
            placeholderTextColor={theme.color.muted}
            style={styles.sheetInput}
          />
          <NativeButton
            label={t("cancel")}
            onPress={() => setSheetOpen(false)}
            variant="secondary"
          />
        </View>
      </NativeSheet>
    </View>
  );
}

function GalleryState({
  children,
  label
}: {
  children: ReactNode;
  label: string;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  return (
    <View style={styles.galleryState}>
      {children}
      <Text style={styles.galleryStateLabel}>{label}</Text>
    </View>
  );
}

function GallerySection({
  children,
  title
}: {
  children: ReactNode;
  title: string;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionContent}>{children}</View>
    </View>
  );
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    closeIcon: {
      color: theme.color.text,
      fontSize: theme.space.large
    },
    content: { gap: theme.space.large, padding: theme.space.medium },
    description: {
      color: theme.color.textSecondary,
      fontSize: theme.space.medium - 2,
      lineHeight: theme.space.medium + theme.space.small - 1
    },
    header: { alignItems: "flex-start", flexDirection: "row" },
    headerCopy: { flex: 1 },
    galleryState: {
      alignItems: "center",
      gap: theme.space.small / 2,
      width: "100%"
    },
    galleryStateLabel: {
      color: theme.color.muted,
      fontSize: theme.space.small
    },
    glyphGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.space.medium
    },
    glyphPreview: {
      alignItems: "center",
      gap: theme.space.small / 2,
      minWidth: theme.control.regular
    },
    inline: { flexDirection: "row", gap: theme.space.small },
    moreIcon: {
      color: theme.color.text,
      fontSize: theme.space.medium,
      fontWeight: "800",
      letterSpacing: theme.space.small / 10
    },
    root: { backgroundColor: theme.color.background, flex: 1 },
    section: { gap: theme.space.small },
    sectionContent: { gap: theme.space.small },
    sectionTitle: {
      color: theme.color.muted,
      fontSize: theme.space.small + 2,
      fontWeight: "700"
    },
    sheetContent: {
      gap: theme.space.medium,
      padding: theme.space.large
    },
    sheetInput: {
      backgroundColor: theme.color.panel,
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      color: theme.color.text,
      fontSize: 16,
      minHeight: 48,
      paddingHorizontal: theme.space.medium
    },
    sheetTitle: {
      color: theme.color.text,
      fontSize: theme.space.large,
      fontWeight: "700"
    },
    title: {
      color: theme.color.text,
      fontSize: theme.space.large,
      fontWeight: "700"
    },
    trailing: {
      color: theme.color.muted,
      fontSize: theme.space.large
    }
  });
}
