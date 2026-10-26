import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const evidenceDirectory = resolve(root, '.expo/release-acceptance');

export function sanitize(value) {
  return String(value ?? '')
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, '$1 [REDACTED]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sb_secret_|npm_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi, '$1[REDACTED]');
}

export function failure(type, message) {
  return Object.assign(new Error(message), { type });
}

export function runProcess(command, args, { cwd = root, environment = process.env, timeoutMs = 120_000 } = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env: environment, windowsHide: true, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', timedOut = false, spawnError = null, finished = false;
    const limit = 2 * 1024 * 1024;
    let truncated = false;
    const collect = (old, bytes) => {
      const next = old + bytes.toString();
      if (next.length <= limit) return next;
      truncated = true;
      return next.slice(0, limit / 2) + '\n[output truncated]\n' + next.slice(-limit / 2);
    };
    child.stdout?.on('data', (bytes) => { stdout = collect(stdout, bytes); });
    child.stderr?.on('data', (bytes) => { stderr = collect(stderr, bytes); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
      }
    }, timeoutMs);
    const finish = (exitCode, signal = null) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      done({ exitCode, signal, timedOut, error: spawnError, truncated, stdout: sanitize(stdout), stderr: sanitize(stderr) });
    };
    child.once('error', (error) => { spawnError = sanitize(error.message); finish(null); });
    child.once('close', finish);
  });
}

export function createJournal(filename, { directory = evidenceDirectory, now = Date.now, execute = runProcess, suites = [], environment = process.env } = {}) {
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, filename);
  if (existsSync(path)) {
    const attempts = resolve(directory, 'attempts'); mkdirSync(attempts, { recursive: true });
    copyFileSync(path, resolve(attempts, now() + '-' + filename));
  }
  const data = {
    version: 1, startedAt: new Date(now()).toISOString(), status: 'IN_PROGRESS', stage: 'initialize',
    commit: environment.GITHUB_SHA ?? null, runId: environment.GITHUB_RUN_ID ?? null,
    runAttempt: environment.GITHUB_RUN_ATTEMPT ?? null,
    image: null, commands: [], attempts: [],
    suites: suites.map(([label]) => ({ label, status: 'NOT_STARTED' })),
    environment: { owned: false, created: false, ready: false, cleanup: 'NOT_REQUIRED' }, failure: null,
  };
  const save = () => writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  save();
  return {
    data, directory, now, save,
    async command(stage, command, args, options = {}) {
      data.stage = stage;
      const record = { number: data.commands.length + 1, stage, command, args: args.map(sanitize), startedAt: new Date(now()).toISOString(), exitCode: null, status: 'RUNNING' };
      data.commands.push(record); save();
      let result;
      try { result = await execute(command, args, { ...options, environment: options.environment ?? environment }); }
      catch (error) { result = { exitCode: null, error: sanitize(error.message), stdout: '', stderr: '' }; }
      result = { ...result, stdout: sanitize(result.stdout), stderr: sanitize(result.stderr), error: result.error ? sanitize(result.error) : null };
      Object.assign(record, result, { finishedAt: new Date(now()).toISOString(), status: result.exitCode === 0 && !result.timedOut && !result.error ? 'SUCCESS' : 'FAIL' });
      save();
      return result;
    },
    fail(error) {
      data.status = 'FAIL';
      data.failure = { type: error.type ?? 'UNEXPECTED_ERROR', stage: data.stage, message: sanitize(error.message), at: new Date(now()).toISOString() };
      data.unstartedSuites = data.suites.filter((suite) => suite.status === 'NOT_STARTED').map((suite) => suite.label);
      save();
    },
  };
}
