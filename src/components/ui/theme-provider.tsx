import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SystemUI from 'expo-system-ui';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform, useColorScheme } from 'react-native';
import { darkColors, lightColors } from './theme';
export type ThemeMode = 'light' | 'dark' | 'system';
type ThemeContextValue = { mode: ThemeMode; resolved: 'light' | 'dark'; colors: typeof lightColors | typeof darkColors; setMode: (mode: ThemeMode) => void };
const ThemeContext = createContext<ThemeContextValue>({ mode: 'system', resolved: 'light', colors: lightColors, setMode: () => undefined });

/**
 * ThemeProvider — single source of truth for the resolved theme.
 *
 * The resolved theme flows down to every root surface so the whole app
 * switches together (never a light page behind dark cards):
 *   - Web: html/body document background + native color-scheme;
 *   - Native: root view background via expo-system-ui;
 *   - Navigation stack: RootStack (see src/app/_layout.tsx) reads
 *     colors.background for the Stack contentStyle and StatusBar.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  const [mode, setModeState] = useState<ThemeMode>('system');
  useEffect(() => { void AsyncStorage.getItem('tasktrace.theme').then((value) => { if (value === 'light' || value === 'dark' || value === 'system') setModeState(value); }); }, []);
  const setMode = (next: ThemeMode) => { setModeState(next); void AsyncStorage.setItem('tasktrace.theme', next); };
  const resolved: 'light' | 'dark' = mode === 'system' ? system : mode;
  useEffect(() => {
    const background = resolved === 'dark' ? darkColors.background : lightColors.background;
    if (Platform.OS === 'web') {
      document.documentElement.style.backgroundColor = background;
      document.body.style.backgroundColor = background;
      document.body.style.setProperty('color-scheme', resolved);
      return;
    }
    SystemUI.setBackgroundColorAsync(background).catch(() => undefined);
  }, [resolved]);
  const value = useMemo(() => { return { mode, resolved, colors: resolved === 'dark' ? darkColors : lightColors, setMode }; }, [mode, resolved]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);
