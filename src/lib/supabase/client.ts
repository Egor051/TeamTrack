import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { supabaseEnv } from '@/lib/env';
import type { Database as DatabaseSchema } from '@/types/database.types';

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

export const supabase: SupabaseClient<DatabaseSchema> = createClient<DatabaseSchema>(
  supabaseEnv().url,
  supabaseEnv().anonKey,
  {
    auth: {
      storage: new StorageAdapter(),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: typeof window !== 'undefined',
    },
  },
);

// Re-export types used throughout the app
export type Database = DatabaseSchema;
export type Profile = Database['public']['Tables']['profiles']['Row'];
export type Project = Database['public']['Tables']['projects']['Row'];
export type Task = Database['public']['Tables']['tasks']['Row'];
export type TaskItem = Database['public']['Tables']['task_items']['Row'];
