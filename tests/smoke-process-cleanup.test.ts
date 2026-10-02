import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { closeSmokeBrowser, stopSmokeServer } from '../scripts/smoke-process-cleanup.mjs';

describe('browser smoke cleanup', () => {
  it('closes the whole browser session even when the offline reset fails', () => {
    const browser = vi.fn((command: string) => { if (command === 'set') throw new Error('page crashed'); });
    closeSmokeBrowser(browser); expect(browser.mock.calls.map(([cmd]) => cmd)).toEqual(['set', 'close']);
    expect(() => closeSmokeBrowser(() => { throw new Error('close failed'); })).toThrow('close failed');
  });
  it('awaits the owned server and polling process exit and releases its port', async () => {
    const child = spawn(process.execPath, ['-e', "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));setInterval(()=>{},10)"], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const [chunk] = await once(child.stdout!, 'data'); const port = Number(String(chunk).trim());
      expect(port).toBeGreaterThan(0); await stopSmokeServer(child);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      const refused = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(false); });
        socket.once('error', () => { socket.destroy(); resolve(true); });
      });
      expect(refused).toBe(true);
    } finally { await stopSmokeServer(child); }
  });
});
