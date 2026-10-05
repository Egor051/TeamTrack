// Storage failures must never turn a confirmed denial into an offline allow.
// Decisions are account scoped and fenced against responses started earlier.
const decisions = new Map<string, { denied: boolean; epoch: number }>();
let epoch = 0;
const identity = (userId: string, key: string) => `${userId}:${key}`;
export const cacheAccessEpoch = () => epoch;
export const cacheAccessDecision = (userId: string, key: string) => decisions.get(identity(userId, key))?.denied;
export function denyCacheAccess(userId: string, key: string): void {
  decisions.set(identity(userId, key), { denied: true, epoch: ++epoch });
}
export function deniedSince(userId: string, key: string, baseline: number): boolean {
  const state = decisions.get(identity(userId, key)); return !!state?.denied && state.epoch > baseline;
}
export function confirmCacheAccess(userId: string, key: string, baseline: number): boolean {
  if (deniedSince(userId, key, baseline)) return false;
  decisions.set(identity(userId, key), { denied: false, epoch: ++epoch }); return true;
}
