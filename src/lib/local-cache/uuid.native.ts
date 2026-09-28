import { randomUUID } from 'expo-crypto';

export function newOperationId(): string {
  return randomUUID();
}
