/* 构建：把 src/enter-swap.js 打包成两种可安装的产物。
 *   node build.mjs
 * 产物：
 *   dist/enter-to-newline.user.js     油猴脚本（Tampermonkey / Violentmonkey / Greasemonkey）
 *   dist/extension/{manifest.json,content.js}   Chrome/Edge MV3 免安装（开发者模式加载）
 *
 * 发新版本时：改下面 META.version → node build.mjs → git commit & push。
 * 已经通过 @downloadURL 安装的用户，Tampermonkey 会自动检查并升级。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

/* 仓库位置：换账号/仓库名时改这两个环境变量或这里的默认值 */
const OWNER = process.env.GITHUB_OWNER || 'zhaoshuai20040401';
const REPO = process.env.GITHUB_REPO || 'enter-to-newline';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const HOMEPAGE = `https://github.com/${OWNER}/${REPO}`;
const RAW_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/dist/enter-to-newline.user.js`;

const META = {
  name: 'Enter 换行 / Ctrl+Enter 发送（DeepSeek + 豆包）',
  version: '1.0.1',
  description: '把 DeepSeek、豆包网页版的回车键改成换行，Ctrl/Cmd+Enter 才发送消息。',
  matches: [
    'https://chat.deepseek.com/*',
    'https://www.doubao.com/*',
    'https://doubao.com/*',
  ],
};

const userScriptHeader = `// ==UserScript==
// @name         ${META.name}
// @name:en      Enter = Newline, Ctrl+Enter = Send (DeepSeek + Doubao)
// @namespace    ${HOMEPAGE}
// @version      ${META.version}
// @description  ${META.description}
// @description:en Swap Enter/Ctrl+Enter on DeepSeek and Doubao web chat.
// @author       ${OWNER}
// @license      MIT
// @homepageURL  ${HOMEPAGE}
// @supportURL   ${HOMEPAGE}/issues
// @downloadURL  ${RAW_URL}
// @updateURL    ${RAW_URL}
${META.matches.map((m) => `// @match        ${m}`).join('\n')}
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

`;

const manifest = {
  manifest_version: 3,
  name: META.name,
  version: META.version,
  description: META.description,
  content_scripts: [
    {
      matches: META.matches,
      js: ['content.js'],
      run_at: 'document_start',
      all_frames: false,
    },
  ],
};

const core = await readFile(join(root, 'src', 'enter-swap.js'), 'utf8');

await mkdir(join(root, 'dist', 'extension'), { recursive: true });
await writeFile(join(root, 'dist', 'enter-to-newline.user.js'), userScriptHeader + core, 'utf8');
await writeFile(join(root, 'dist', 'extension', 'content.js'), core, 'utf8');
await writeFile(join(root, 'dist', 'extension', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('构建完成：');
console.log('  dist/enter-to-newline.user.js');
console.log('  dist/extension/manifest.json');
console.log('  dist/extension/content.js');
console.log('油猴安装 / 自动更新地址：');
console.log('  ' + RAW_URL);
