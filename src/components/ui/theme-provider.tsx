import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { darkColors, lightColors } from './theme';
export type ThemeMode = 'light' | 'dark' | 'system';
type ThemeContextValue = { mode: ThemeMode; resolved: 'light' | 'dark'; colors: typeof lightColors | typeof darkColors; setMode: (mode: ThemeMode) => void };
const ThemeContext = createContext<ThemeContextValue>({ mode: 'system', resolved: 'light', colors: lightColors, setMode: () => undefined });
export function ThemeProvider({ children }: { children: ReactNode }) { const system = useColorScheme() === 'dark' ? 'dark' : 'light'; const [mode, setModeState] = useState<ThemeMode>('system'); useEffect(() => { void AsyncStorage.getItem('tasktrace.theme').then((value) => { if (value === 'light' || value === 'dark' || value === 'system') setModeState(value); }); }, []); const setMode = (next: ThemeMode) => { setModeState(next); void AsyncStorage.setItem('tasktrace.theme', next); }; const value = useMemo(() => { const resolved = mode === 'system' ? system : mode; return { mode, resolved, colors: resolved === 'dark' ? darkColors : lightColors, setMode }; }, [mode, system]); return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>; }
export const useTheme = () => useContext(ThemeContext);
