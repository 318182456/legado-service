import { spawn } from 'node:child_process';
import { ensureRuntimeDependencies } from './runtime-dependencies.mjs';

try {
  ensureRuntimeDependencies(process.cwd());
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('未指定容器启动命令');
  const child = spawn(command, args, { stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error('[Startup]', error.message); process.exit(1); });
  child.on('exit', code => process.exit(code ?? 1));
} catch (error) {
  console.error('[Startup]', error.message);
  process.exit(1);
}
