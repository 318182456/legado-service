import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { assetUrl } from '../src/utils/assetUrl';
import { handleExportCustomTheme } from '../worker/handlers/assets';
import type { Env } from '../worker/types';

test('图片路径的中文、空格和 # 不丢失，绝对地址及 blob 不拼接 repo', () => {
  assert.equal(assetUrl('bg/夜色 #1&2.png', 'http://local'), 'http://local/repo/bg/%E5%A4%9C%E8%89%B2%20%231%262.png');
  assert.equal(assetUrl('https://images.invalid/a.png', 'http://local'), 'https://images.invalid/a.png');
  assert.equal(assetUrl('blob:http://local/123', 'http://local'), 'blob:http://local/123');
});

test('导出包含三个模式的中文图片，ZIP 可完整解压且不会串用同名图片', async () => {
  const config = {
    name: '背景验证', bgType: 2, bgStr: 'day/背景.png',
    bgTypeNight: 2, bgStrNight: 'night/背景.png',
    bgTypeEInk: 2, bgStrEInk: 'eink/墨水屏.png',
  };
  const env = {
    DB: { prepare: () => ({ bind() { return this; }, first: async () => ({ config: JSON.stringify(config) }) }) },
    ASSETS_R2: { get: async (key: string) => ({ arrayBuffer: async () => new TextEncoder().encode(key).buffer }) },
  } as unknown as Env;
  const response = await handleExportCustomTheme(new Request('http://local/export'), env, '1');
  assert.equal(response.status, 200);
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const saved = JSON.parse(strFromU8(files['readConfig.json']));
  assert.equal(strFromU8(files[saved.bgStr]), 'day/背景.png');
  assert.equal(strFromU8(files[saved.bgStrNight]), 'night/背景.png');
  assert.equal(strFromU8(files[saved.bgStrEInk]), 'eink/墨水屏.png');
  assert.notEqual(saved.bgStr, saved.bgStrNight);
});
