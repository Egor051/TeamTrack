export function newOperationId(): string {
  return globalThis.crypto.randomUUID();
}
