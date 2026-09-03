/**
 * TaskTrace — Auth error mapping to UI messages.
 *
 * Supabase error objects contain internal information that should never
 * be exposed to users. This module maps those errors to human-readable
 * messages.
 *
 * @example
 *   import { mapSupabaseAuthError } from '@/lib/errors/auth-errors';
 *   const message = mapSupabaseAuthError(error);
 */

type SupabaseErrorCode =
  | 'invalid_login_credentials'
  | 'email_not_confirmed'
  | 'email_in_use'
  | 'weak_password'
  | 'user_not_found'
  | 'invalid_password'
  | 'session_expired'
  | 'network_error'
  | 'too_many_attempts'
  | 'invalid_reset_token'
  | 'unexpected';

const errorMap: Record<SupabaseErrorCode, string> = {
  invalid_login_credentials: 'Неверные учетные данные',
  email_not_confirmed: 'Подтвердите email, пожалуйста',
  email_in_use: 'Этот email уже используется',
  weak_password: 'Слишком легкий пароль (минимум 8 символов, нужны буквы и цифры)',
  user_not_found: 'Пользователь не найден',
  invalid_password: 'Неверный пароль',
  session_expired: 'Сессия истекла. Пожалуйста, войдите заново',
  network_error: 'Сетевая ошибка. Проверьте соединение',
  too_many_attempts: 'Слишком много попыток. Попробуйте позже',
  invalid_reset_token: 'Ссылка для сброса пароля недействительна или истекла',
  unexpected: 'Непредвиденная ошибка. Попробуйте снова',
};

/**
 * Map a Supabase auth error to a user-friendly message.
 * Falls back to a generic message if the error code is unknown.
 */
export function mapSupabaseAuthError(
  error: unknown,
): string {
  if (!error) {
    return 'Неизвестная ошибка';
  }

  // Supabase JS SDK structures error information in various shapes.
  const err = error as {
    message?: string;
    status?: number;
    code?: string;
    details?: unknown;
  };

  // Primary path: error.code
  if (err?.code && Object.values(errorMap).includes(errorMap[err.code as SupabaseErrorCode] ?? '')) {
    return errorMap[err.code as SupabaseErrorCode];
  }

  // Secondary path: error.status / error.statusText
  // Common Supabase HTTP statuses
  if (err?.status === 400) {
    if (err?.message?.includes('weak')) return errorMap.weak_password;
    if (err?.message?.includes('taken')) return errorMap.email_in_use;
    if (err?.message?.includes('sign in')) return errorMap.invalid_login_credentials;
  }
  if (err?.status === 406) {
    return errorMap.invalid_login_credentials;
  }
  if (err?.status === 409) {
    return errorMap.email_in_use;
  }
  if (err?.status === 417 || err?.status === 401) {
    return errorMap.session_expired;
  }

  // Tertiary path: error.message
  if (err?.message) {
    const msg = String(err.message);
    // Check if it matches a known code substring
    if (msg.includes('invalid login')) return errorMap.invalid_login_credentials;
    if (msg.includes('Email not confirmed')) return errorMap.email_not_confirmed;
    if (msg.includes('already been taken')) return errorMap.email_in_use;
    if (msg.includes('weak password')) return errorMap.weak_password;
    if (msg.includes('Email is not confirmed')) return errorMap.email_not_confirmed;
    if (msg.includes('Invalid login') || msg.includes('Invalid credentials')) return errorMap.invalid_login_credentials;
    if (msg.includes('reset password')) return errorMap.invalid_reset_token;
    if (msg.includes('expired')) return errorMap.session_expired;
    if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('fetch')) {
      return errorMap.network_error;
    }
  }

  return errorMap.unexpected;
}

/**
 * Convenience: short aliases for common UI usage.
 */

export const AuthErrorMessages = {
  invalidCredentials: 'Неверный email или пароль',
  emailNotConfirmed: 'Подтвердите ваш email',
  passwordTooWeak: 'Пароль должен иметь минимум 8 символов, нужны буквы и цифры',
  emailAlreadyUsed: 'Этот email уже зарегистрирован',
  networkProblem: 'Проблемы с сетью',
  resetLinkExpired: 'Ссылка для сброса пароля устарела',
  tooManyAttempts: 'Слишком много попыток. Попробуйте позже',
} as const;

export type AuthErrorMessageKey = keyof typeof AuthErrorMessages;
