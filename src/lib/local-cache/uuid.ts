// Node test driver; Metro uses uuid.web.ts or uuid.native.ts.
export function newOperationId(): string {
  return globalThis.crypto.randomUUID();
}
