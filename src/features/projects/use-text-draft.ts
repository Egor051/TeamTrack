import { useCallback, useState } from 'react';

export type TextSnapshot = { id: string; name: string; description: string | null };
type TextValues = { name: string; description: string };
export type TextDraft = TextValues & { id: string; baseline: TextValues };
const values = (row: TextSnapshot): TextValues => ({ name: row.name, description: row.description ?? '' });
export const draftChanged = (draft: TextDraft) => draft.name !== draft.baseline.name || draft.description !== draft.baseline.description;
export const draftConflicts = (draft: TextDraft | null, remote: TextSnapshot | null) => !!draft && !!remote
  && draft.id === remote.id && (draft.baseline.name !== remote.name || draft.baseline.description !== (remote.description ?? ''));
export const beginTextDraft = (remote: TextSnapshot): TextDraft => ({ id: remote.id, ...values(remote), baseline: values(remote) });
export const refreshTextDraft = (draft: TextDraft | null, remote: TextSnapshot): TextDraft | null => {
  if (!draft || draft.id !== remote.id) return null;
  return draftChanged(draft) ? draft : beginTextDraft(remote);
};

export function useTextDraft() {
  const [draft, setDraft] = useState<TextDraft | null>(null);
  const begin = useCallback((remote: TextSnapshot) => setDraft(beginTextDraft(remote)), []);
  const accept = useCallback((remote: TextSnapshot) => setDraft((old) => refreshTextDraft(old, remote)), []);
  const change = useCallback((patch: Partial<TextValues>) => setDraft((old) => old ? { ...old, ...patch } : null), []);
  const cancel = useCallback(() => setDraft(null), []);
  const rebase = useCallback((remote: TextSnapshot) => setDraft((old) => old?.id === remote.id
    ? { ...old, baseline: values(remote) } : old), []);
  return { draft, begin, accept, change, cancel, rebase };
}
