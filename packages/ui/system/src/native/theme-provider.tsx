import {
  createContext,
  type PropsWithChildren,
  useContext,
  useMemo
} from "react";
import { useColorScheme } from "react-native";
import {
  nativeTheme,
  resolveNativeTheme,
  type NativeTheme,
  type NativeThemeMode
} from "./tokens";

export type NativeThemePreference = NativeThemeMode | "system";

const NativeThemeContext = createContext<NativeTheme>(nativeTheme);

export interface NativeThemeProviderProps extends PropsWithChildren {
  /** Defaults to the operating system preference when no product override exists. */
  mode?: NativeThemePreference;
}

/**
 * Supplies the resolved Native semantic theme to UI System primitives and
 * application composition. The provider is intentionally UI-only: product
 * settings decide which preference, if any, it receives.
 */
export function NativeThemeProvider({
  children,
  mode = "system"
}: NativeThemeProviderProps) {
  const systemMode = useColorScheme();
  const resolvedMode =
    mode === "system" ? (systemMode === "light" ? "light" : "dark") : mode;
  const theme = useMemo(() => resolveNativeTheme(resolvedMode), [resolvedMode]);

  return (
    <NativeThemeContext.Provider value={theme}>
      {children}
    </NativeThemeContext.Provider>
  );
}

export function useNativeTheme(): NativeTheme {
  return useContext(NativeThemeContext);
}
