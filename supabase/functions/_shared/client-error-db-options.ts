/** Server-only connection settings. Never downgrade remote TLS on failure. */
export function clientErrorDatabaseOptions(connection: string | undefined, ca?: string) {
  let hostname: string;
  try {
    const url = new URL(connection ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
    hostname = url.hostname;
  } catch { throw new Error('Client diagnostic database connection is missing or invalid'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  return {
    max: 1, prepare: false, max_pipeline: 1, fetch_types: false,
    idle_timeout: 5, connect_timeout: 2,
    ssl: local ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    connection: { application_name: 'tasktrace_client_errors', statement_timeout: 2000, lock_timeout: 500 },
  };
}
