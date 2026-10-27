import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const stampName = '.legado-dependencies.sha256';

function fingerprint(root) {
  return createHash('sha256')
    .update(readFileSync(join(root, 'package.json')))
    .update('\0')
    .update(readFileSync(join(root, 'package-lock.json')))
    .digest('hex');
}

export function markRuntimeDependencies(root) {
  writeFileSync(join(root, 'node_modules', stampName), fingerprint(root));
}

/** /app 和 node_modules 可来自不同的卷，以清单指纹及实际安装情况判断是否需要同步。 */
export function ensureRuntimeDependencies(root, run = execFileSync) {
  const expected = fingerprint(root);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const installed = () => Object.keys(dependencies).every(name =>
    existsSync(join(root, 'node_modules', name, 'package.json')));
  const stamp = join(root, 'node_modules', stampName);
  if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === expected && installed()) return false;

  console.log('[Dependencies] 依赖与当前代码不一致，正在执行 npm ci...');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['ci', '--include=dev', '--no-audit', '--no-fund'],
    { cwd: root, stdio: 'inherit', timeout: 10 * 60 * 1000, shell: process.platform === 'win32' });
  if (!installed()) throw new Error('依赖安装不完整，停止启动，请检查 npm ci 输出');
  markRuntimeDependencies(root);
  return true;
}
