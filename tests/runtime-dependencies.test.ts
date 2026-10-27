import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureRuntimeDependencies, markRuntimeDependencies } from '../runtime-dependencies.mjs';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'legado-runtime-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { linkedom: '1.0.0' } }));
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  mkdirSync(join(root, 'node_modules'));
  const install = () => {
    mkdirSync(join(root, 'node_modules/linkedom'), { recursive: true });
    writeFileSync(join(root, 'node_modules/linkedom/package.json'), '{}');
  };
  return { root, install };
}

test('旧依赖卷没有同步标记时先安装；标记一致且包存在时不重复安装', t => {
  const { root, install } = fixture(t);
  let installs = 0;
  const run = (_command: string, args: string[], options: any) => {
    installs++;
    assert.deepEqual(args, ['ci', '--include=dev', '--no-audit', '--no-fund']);
    assert.equal(options.cwd, root);
    install();
  };
  assert.equal(ensureRuntimeDependencies(root, run), true);
  assert.equal(ensureRuntimeDependencies(root, run), false);
  assert.equal(installs, 1);
});

test('清单变化或已安装的包被移除时都会补装', t => {
  const { root, install } = fixture(t);
  install(); markRuntimeDependencies(root);
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
  let installs = 0;
  assert.equal(ensureRuntimeDependencies(root, () => { installs++; install(); }), true);
  rmSync(join(root, 'node_modules/linkedom/package.json'));
  assert.equal(ensureRuntimeDependencies(root, () => { installs++; install(); }), true);
  assert.equal(installs, 2);
});

test('安装失败不更新依赖标记，不会假装同步成功', t => {
  const { root, install } = fixture(t);
  install(); markRuntimeDependencies(root);
  const stamp = join(root, 'node_modules/.legado-dependencies.sha256');
  const before = readFileSync(stamp, 'utf8');
  writeFileSync(join(root, 'package-lock.json'), '{"changed":true}');
  assert.throws(() => ensureRuntimeDependencies(root, () => { throw new Error('模拟安装失败'); }), /模拟安装失败/);
  assert.equal(readFileSync(stamp, 'utf8'), before);
});

test('容器入口在依赖就绪后启动指定服务，并返回服务退出码', t => {
  const { root, install } = fixture(t);
  install(); markRuntimeDependencies(root);
  const entry = fileURLToPath(new URL('../docker-entrypoint.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, process.execPath, '-e', 'console.log("service-started"); process.exit(7)'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /service-started/);
});

test('模拟未安装 linkedom：服务器入口仍可加载，静态 HTML 检测返回待确认', () => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const code = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith('linkedom')) throw Object.assign(new Error('simulated missing linkedom'), { code: 'ERR_MODULE_NOT_FOUND' });
      return next(specifier, context);
    }});
    await import('./worker/index.ts');
    const { checkBookSource } = await import('./worker/handlers/availability-check.ts');
    globalThis.fetch = async () => new Response('<div class="book"><a href="/b/1">测试书</a></div>');
    const result = await checkBookSource(JSON.stringify({ searchUrl: '/search', ruleSearch: { bookList: '.book', name: 'a@text', bookUrl: 'a@href' } }), 'https://source.invalid');
    assert.equal(result.verdict, 'skipped');
    assert.equal(result.reason, 'rule-unsupported');
    console.log('startup-without-linkedom-ok');
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: project, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /startup-without-linkedom-ok/);
});
