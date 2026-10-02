async function exitsWithin(exited, ms) {
  let timer;
  try {
    return await Promise.race([exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally { clearTimeout(timer); }
}

export function closeSmokeBrowser(browser) {
  // Reset can fail if a page/context crashed. Closing the session must still run.
  try { browser('set', 'offline', 'off'); } catch { /* close below is authoritative */ }
  browser('close');
}

export async function stopSmokeServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  if (await exitsWithin(exited, 3000)) return;
  server.kill('SIGKILL');
  if (!await exitsWithin(exited, 3000)) {
    throw new Error(`Smoke server ${server.pid} did not exit`);
  }
}
