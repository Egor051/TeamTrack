import { afterEach, describe, expect, it, vi } from 'vitest';
import { mutationUserMessage } from '@/lib/errors/user-message';

afterEach(() => vi.unstubAllEnvs());

describe('unsupported offline mutations', () => {
  it('uses the existing network error with the flag off', () => {
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_WRITE_ENABLED', 'false');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(mutationUserMessage({ message: 'Failed to fetch' }, 'fallback')).toBe('Не удалось связаться с сервером. Проверьте соединение и повторите попытку.');
    consoleError.mockRestore();
  });

  it('asks for connectivity with the flag on while preserving auth errors', () => {
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_WRITE_ENABLED', 'true');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(mutationUserMessage({ message: 'Failed to fetch' }, 'fallback')).toBe('Для этого действия требуется подключение к интернету.');
    expect(mutationUserMessage(new Error('Для этого действия требуется подключение к интернету.'), 'fallback')).toBe('Для этого действия требуется подключение к интернету.');
    expect(mutationUserMessage({ message: 'access denied', status: 403 }, 'fallback')).toBe('Доступ запрещён. У вашей роли нет прав на это действие.');
    consoleError.mockRestore();
  });
});
