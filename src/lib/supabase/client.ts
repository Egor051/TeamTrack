import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { supabaseEnv } from '@/lib/env';
import type { Database as DatabaseSchema } from '@/types/database.types';
import { connectivityFetch } from '@/lib/connectivity/fetch';
import { probeSupabase } from './connectivity-probe';

/**
 * TaskTrace — centralized Supabase client.
 *
 * Uses Expo SecureStore for session persistence on Android/iOS. On Web,
 * AsyncStorage is backed by browser storage and remains the platform fallback.
 *
 * Every part of the app imports this single instance instead of
 * creating ad-hoc clients.
 */

/**
 * Supabase requires an async string storage adapter. Native sessions use the
 * OS-backed keychain/keystore; web uses the browser-compatible adapter.
 */
class StorageAdapter {
  async getItem(key: string): Promise<string | null> {
    try {
      return Platform.OS === 'web' ? await AsyncStorage.getItem(key) : await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') await AsyncStorage.setItem(key, value);
    else await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }

  async removeItem(key: string): Promise<void> {
    if (Platform.OS === 'web') await AsyncStorage.removeItem(key);
    else await SecureStore.deleteItemAsync(key);
  }
}

const environment = supabaseEnv();
const sessionStorage = new StorageAdapter();
// Match the SDK's default key, preserving existing installations' sessions.
const sessionStorageKey = `sb-${new URL(environment.url).hostname.split('.')[0]}-auth-token`;
export async function clearPersistedSession(): Promise<void> {
  await sessionStorage.removeItem(sessionStorageKey);
}
export async function readPersistedSession(): Promise<Session | null> {
  try {
    const raw = await sessionStorage.getItem(sessionStorageKey);
    if (!raw) return null;
    const session = JSON.parse(raw) as Partial<Session>;
    if (!session.user?.id || typeof session.access_token !== 'string' || !session.access_token
      || typeof session.refresh_token !== 'string' || !session.refresh_token
      || typeof session.expires_at !== 'number') return null;
    return session as Session;
  } catch { return null; }
}

export async function probeSupabaseConnectivity(): Promise<void> {
  return probeSupabase(environment.url, environment.anonKey, supabase.auth);
}

export const supabase: SupabaseClient<DatabaseSchema> = createClient<DatabaseSchema>(
  environment.url,
  environment.anonKey,
  {
    auth: {
      storage: sessionStorage,
      storageKey: sessionStorageKey,
      autoRefreshToken: true,
      persistSession: true,
      flowType: 'pkce',
      detectSessionInUrl: false,
      experimental: {
        appendPkceFlowIdToRedirects: true,
      },
    },
    global: { fetch: connectivityFetch },
  },
);

// Re-export types used throughout the app
export type Database = DatabaseSchema;
export type Profile = Database['public']['Tables']['profiles']['Row'];
export type Project = Database['public']['Tables']['projects']['Row'];
export type Task = Database['public']['Tables']['tasks']['Row'];
export type TaskItem = Database['public']['Tables']['task_items']['Row'];
