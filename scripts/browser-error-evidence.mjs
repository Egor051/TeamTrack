// WebKit reports caught Fetch CORS diagnostics as Playwright pageerror.
// Keep them as evidence; a genuinely unhandled rejection is checked separately
// through DOM error/unhandledrejection and the provider's rejection event.
export function expectedProviderDiagnostic(record, apiOrigin) {
  if (record.engine !== 'webkit') return false;
  if (record.name === 'Fetch API cannot load http' && /^http:\/\/127\.0\.0\.1:\d+$/.test(apiOrigin)) {
    // Playwright's error-name split consumes the first slash after "http:".
    return record.message.startsWith('/' + new URL(apiOrigin).host + '/rest/v1/rpc/')
      && record.message.endsWith(' due to access control checks.');
  }
  return false;
}
