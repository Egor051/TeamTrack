export const OFFLINE_BOOTSTRAP_VERSION = 1;
export const BOOTSTRAP_KEY = 'bootstrap:metadata';
export const BASIC_DATASETS = ['profile', 'projects', 'members', 'profiles', 'tasks', 'roles', 'overrides',
  'assignees', 'items', 'templates', 'template_items', 'daily_audit'] as const;
export const EXTENDED_DATASETS = ['history', 'notifications', 'last_editors'] as const;
export type OfflineScheme = 'basic' | 'extended';
export type Dataset = typeof BASIC_DATASETS[number] | typeof EXTENDED_DATASETS[number];
export type DatasetVersion = { revision: string; count: number; pages: string[] };
export type AccountManifest = {
  schema_version: number; user_id: string; generated_at: string; day_start: string; history_start: string;
  datasets: Partial<Record<Dataset, DatasetVersion>>;
};
export type DatasetState = DatasetVersion & { offset: number; status: 'pending' | 'loading' | 'complete' | 'error'; error?: string };
export type BootstrapMetadata = {
  user_id: string; scheme: OfflineScheme; schema_version: number;
  status: 'not_started' | 'running' | 'updating' | 'ready' | 'partial' | 'error';
  started_at: string | null; completed_at: string | null; last_successful_sync_at: string | null;
  progress: number; offline_ready: boolean; error: string | null;
  manifest: AccountManifest | null; datasets: Partial<Record<Dataset, DatasetState>>;
  assets_ready: boolean; basic_ready: boolean; extended_ready: boolean;
  lease: { owner: string; expires_at: number } | null;
};
export function requiredDatasets(scheme: OfflineScheme): Dataset[] {
  return scheme === 'extended' ? [...BASIC_DATASETS, ...EXTENDED_DATASETS] : [...BASIC_DATASETS];
}
export function initialBootstrap(userId: string): BootstrapMetadata {
  return { user_id: userId, scheme: 'basic', schema_version: OFFLINE_BOOTSTRAP_VERSION, status: 'not_started',
    started_at: null, completed_at: null, last_successful_sync_at: null, progress: 0, offline_ready: false,
    error: null, manifest: null, datasets: {}, assets_ready: false, basic_ready: false, extended_ready: false, lease: null };
}
export function bootstrapProgress(meta: BootstrapMetadata): number {
  const names = requiredDatasets(meta.scheme);
  const completed = names.reduce((sum, name) => {
    const state = meta.datasets[name];
    return sum + (!state ? 0 : state.status === 'complete' ? 1 : state.count ? Math.min(1, state.offset / state.count) : 0);
  }, meta.assets_ready ? 1 : 0);
  // The final unit is verification of the committed read models.
  return Math.floor(100 * (completed + (meta.offline_ready ? 1 : 0)) / (names.length + 2));
}
export const batchKey = (name: Dataset, revision: string, offset: number) => `bootstrap:batch:${name}:${revision}:${offset}`;
