// A temporary TCP bridge for local stacks whose old Docker port bindings have
// not been restored by Docker Desktop. Does not restart or modify the stack.
import { spawnSync } from 'node:child_process';

export function localDbBridge(container) {
  const run = (args) => {
    const result = spawnSync('docker', args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Docker bridge failed');
    return result.stdout.trim();
  };
  const mapped = spawnSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' });
  if (mapped.status === 0 && /:(\d+)\s*$/m.test(mapped.stdout))
    return { port: Number(mapped.stdout.match(/:(\d+)\s*$/m)[1]), close() {} };
  const network = run(['inspect', container, '--format', '{{.HostConfig.NetworkMode}}']);
  const image = run(['inspect', container.replace('supabase_db_', 'supabase_pg_meta_'), '--format', '{{.Config.Image}}']);
  const name = `tasktrace-db-bridge-${process.pid}`;
  const source = `require('node:net').createServer(client=>{const server=require('node:net').connect({host:${JSON.stringify(container)},port:5432});client.pipe(server).pipe(client);client.on('error',()=>server.destroy());server.on('error',()=>client.destroy());}).listen(5432,'0.0.0.0');`;
  run(['run', '--rm', '-d', '--name', name, '--network', network, '-p', '127.0.0.1::5432', '--entrypoint', 'node', image, '-e', source]);
  const close = () => { spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' }); };
  try {
    const port = Number(run(['port', name, '5432/tcp']).match(/:(\d+)\s*$/m)?.[1]);
    if (!port) throw new Error('Temporary database bridge has no port');
    return { port, close };
  } catch (error) { close(); throw error; }
}
