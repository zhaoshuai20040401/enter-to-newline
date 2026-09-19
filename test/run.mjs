/* 自动化验证：用本机 Chrome + CDP 驱动 mock 站点，不依赖任何 npm 包。
 *
 *   node test/run.mjs
 *
 * 做法：
 *   1. 起一个本地 HTTP 服务，把 mock/ 目录当站点根目录
 *   2. 用 --host-resolver-rules 把 chat.deepseek.com / www.doubao.com 解析到本地，
 *      这样脚本里的「按 hostname 匹配站点」逻辑是真的在跑，而不是被绕过去
 *   3. 打开 mock 页面 → 注入 dist/extension/content.js → 用 CDP 发真实按键
 *      （Input.dispatchKeyEvent 产生 isTrusted=true 的事件，和真人按键一致）
 *   4. 断言 DOM 状态
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mockDir = join(root, 'mock');
const contentScript = join(root, 'dist', 'extension', 'content.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── 结果记录 ───────────────────────── */

const results = [];
let failed = 0;
function check(name, ok, detail) {
  results.push({ name, ok });
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : '   → ' + detail}`);
}

/* ───────────────────────── mock 站点服务 ───────────────────────── */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://placeholder');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    const file = join(mockDir, rel || 'deepseek.html');
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const webPort = server.address().port;

const DEEPSEEK = `http://chat.deepseek.com:${webPort}/deepseek.html`;
const SHADOW = `http://chat.deepseek.com:${webPort}/shadow.html`;
const DOUBAO = `http://www.doubao.com:${webPort}/doubao.html`;
const SHADOW_INPUT = 'document.querySelector("ds-composer").shadowRoot.getElementById("chat-input")';

/* ───────────────────────── 启动 Chrome ───────────────────────── */

function findChrome() {
  const candidates = [
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error('找不到 Chrome / Edge，请手动设置浏览器路径');
}

const profileDir = await mkdtemp(join(tmpdir(), 'etn-chrome-'));
const chromeExe = findChrome();
const chrome = spawn(chromeExe, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-features=HttpsUpgrades',
  '--ignore-certificate-errors',
  // 关键：绕开系统代理，否则 mock 域名会被代理拦掉，请求根本到不了本地服务
  '--no-proxy-server',
  '--user-data-dir=' + profileDir,
  '--remote-debugging-port=0',
  `--host-resolver-rules=MAP chat.deepseek.com 127.0.0.1:${webPort},MAP www.doubao.com 127.0.0.1:${webPort}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeStderr = '';
chrome.stderr.on('data', (d) => { chromeStderr += d.toString(); });

async function devtoolsPort() {
  const portFile = join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 120; i++) {
    try {
      const txt = await readFile(portFile, 'utf8');
      const port = parseInt(txt.split('\n')[0], 10);
      if (port) return port;
    } catch { /* 还没写出来 */ }
    await sleep(100);
  }
  throw new Error('Chrome 没有启动成功：\n' + chromeStderr.slice(-2000));
}

/* ───────────────────────── 极简 CDP 客户端 ───────────────────────── */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('CDP 超时: ' + method));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const debugPort = await devtoolsPort();
const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const pageTarget = targets.find((t) => t.type === 'page');
if (!pageTarget) throw new Error('没有找到可用的页面 target');

const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
});

const cdp = new CDP(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

/* ───────────────────────── 页面操作封装 ───────────────────────── */

const coreSource = await readFile(contentScript, 'utf8');

class Page {
  async goto(url) {
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 200; i++) {
      await sleep(50);
      try {
        // 同时校验 URL，避免导航还在路上时读到上一个文档的 readyState
        const st = await this.eval('location.href + "|" + document.readyState');
        const [href, ready] = st.split('|');
        if (href === url && ready === 'complete') return;
      } catch { /* 导航中 */ }
    }
    throw new Error('页面加载超时: ' + url);
  }
  async eval(expression) {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error('页面内报错: ' + d);
    }
    return r.result.value;
  }
  async inject() {
    await this.eval(coreSource + '\n;true');
  }
  async focus(selector) {
    await this.eval(`document.querySelector(${JSON.stringify(selector)}).focus(); true`);
  }
  // 焦点要打到 shadow root 里面去
  async focusShadow() {
    await this.eval(`${SHADOW_INPUT}.focus(); true`);
  }
  async type(text) {
    await cdp.send('Input.insertText', { text });
    await sleep(30);
  }
  // 发一个真实的回车（isTrusted=true）。text 只在没有 Ctrl/Meta/Alt 时给，
  // 和 puppeteer 的行为一致：带修饰键的回车不会产生字符插入。
  async pressEnter({ ctrl = false, shift = false, meta = false, alt = false } = {}) {
    const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0) | (meta ? 4 : 0) | (alt ? 1 : 0);
    const withText = !(ctrl || meta || alt);
    const base = {
      modifiers,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      key: 'Enter',
      code: 'Enter',
    };
    await cdp.send('Input.dispatchKeyEvent', {
      ...base,
      type: withText ? 'keyDown' : 'rawKeyDown',
      ...(withText ? { text: '\r', unmodifiedText: '\r' } : {}),
    });
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    await sleep(260);   // 留够脚本内部 80ms 发送兜底 / 120ms 回滚复查的时间
  }
  async composition(type) {
    await this.eval(
      `document.activeElement.dispatchEvent(new CompositionEvent(${JSON.stringify(type)}, { bubbles: true })); true`
    );
    await sleep(20);
  }
}

const page = new Page();

/* ───────────────────────── 测试用例 ───────────────────────── */

async function testDeepSeekBasic() {
  console.log('\n[1] DeepSeek（React 受控 textarea）：Enter 换行、Ctrl+Enter 发送');
  await page.goto(DEEPSEEK);
  await page.inject();
  check('脚本在 chat.deepseek.com 上被站点匹配并加载',
    await page.eval('window.__enterToNewlineLoaded === true'), '未加载');

  await page.focus('#chat-input');
  await page.type('第一行');
  await page.pressEnter();
  let s = await page.eval('window.__state()');
  check('Enter 在输入框里插入了换行', s.text === '第一行\n', JSON.stringify(s));
  check('Enter 没有触发发送', s.sends.length === 0, JSON.stringify(s.sends));
  check('站点完全没收到这个回车（在捕获阶段就被拦下）', s.enterSeenBySite === 0, JSON.stringify(s));

  await page.type('第二行');
  s = await page.eval('window.__state()');
  check('插入换行后光标位置正确，可以继续输入', s.text === '第一行\n第二行', JSON.stringify(s));

  await page.pressEnter({ ctrl: true });
  s = await page.eval('window.__state()');
  check('Ctrl+Enter 触发了发送', s.sends.length === 1, JSON.stringify(s.sends));
  check('发送的内容包含两行文本', s.sends[0] === '第一行\n第二行', JSON.stringify(s.sends));
  check('发送后输入框被站点清空', s.text === '', JSON.stringify(s));
}

async function testDeepSeekShiftEnter() {
  console.log('\n[2] DeepSeek：Shift+Enter 保持原生换行（不被脚本干扰）');
  await page.goto(DEEPSEEK);
  await page.inject();
  await page.focus('#chat-input');
  await page.type('甲');
  await page.pressEnter({ shift: true });
  const s = await page.eval('window.__state()');
  check('Shift+Enter 插入了一个换行', s.text === '甲\n', JSON.stringify(s));
  check('Shift+Enter 没有发送', s.sends.length === 0, JSON.stringify(s.sends));
}

async function testDeepSeekLockedNativeInsert() {
  console.log('\n[3] DeepSeek（站点禁止浏览器原生插入换行）：走兜底插入路径');
  await page.goto(DEEPSEEK + '?lock=1');
  await page.inject();
  await page.focus('#chat-input');
  await page.type('兜底');
  await page.pressEnter();
  const s = await page.eval('window.__state()');
  check('原生换行被站点拦住后，兜底插入仍然生效', s.text === '兜底\n', JSON.stringify(s));
  check('兜底插入没有触发发送', s.sends.length === 0, JSON.stringify(s.sends));
}

async function testDeepSeekModalNotHijacked() {
  console.log('\n[4] DeepSeek：弹窗里的输入框不被接管');
  await page.goto(DEEPSEEK);
  await page.inject();
  await page.focus('#rename');
  await page.type('新标题');
  await page.pressEnter();
  const s = await page.eval('window.__state()');
  check('弹窗输入框的回车仍然执行站点自己的逻辑（确认改名）', s.renamed === 1, JSON.stringify(s));
}

async function testDeepSeekIme() {
  console.log('\n[5] DeepSeek：输入法组合期间不接管回车');
  await page.goto(DEEPSEEK);
  await page.inject();
  await page.focus('#chat-input');
  await page.type('ni');

  // 真机上，组合期间的这一个回车会被输入法自己消费掉（选字/上屏），
  // 浏览器不会插入换行；mock 里没有真输入法，所以浏览器会插一个换行。
  // 因此这里验证的是脚本的行为边界，而不是最终文本：
  //   组合期间 → 脚本放行，站点能收到这个回车
  //   组合结束后 → 脚本重新接管，站点收不到回车
  await page.composition('compositionstart');
  await page.pressEnter();
  let s = await page.eval('window.__state()');
  check('组合期间脚本放行了回车，站点收到了它', s.enterSeenBySite === 1, JSON.stringify(s));
  check('组合期间没有发送消息', s.sends.length === 0, JSON.stringify(s.sends));
  check('组合期间脚本没有额外插入换行（只多了 1 个）', s.text === 'ni\n', JSON.stringify(s));

  await page.composition('compositionend');
  await page.pressEnter();
  s = await page.eval('window.__state()');
  check('组合结束后回车重新被脚本接管（站点收不到）', s.enterSeenBySite === 1, JSON.stringify(s));
  check('组合结束后的回车恢复为换行', s.text === 'ni\n\n', JSON.stringify(s));
}

async function testDoubaoBasic() {
  console.log('\n[6] 豆包（contenteditable 编辑器）：Enter 换行、Ctrl+Enter 发送');
  await page.goto(DOUBAO);
  await page.inject();
  check('脚本在 www.doubao.com 上被站点匹配并加载',
    await page.eval('window.__enterToNewlineLoaded === true'), '未加载');

  await page.focus('#editor');
  await page.type('第一行');
  await page.pressEnter();
  let s = await page.eval('window.__state()');
  check('Enter 在编辑器里插入了换行', /<br\s*\/?>/i.test(s.html) || s.text.includes('\n'), JSON.stringify(s));
  check('Enter 没有触发发送', s.sends.length === 0, JSON.stringify(s.sends));

  await page.type('第二行');
  await page.pressEnter({ ctrl: true });
  s = await page.eval('window.__state()');
  check('Ctrl+Enter 触发了发送', s.sends.length === 1, JSON.stringify(s.sends));
  check('发送的内容包含两行文本', /第一行/.test(s.sends[0]) && /第二行/.test(s.sends[0]), JSON.stringify(s.sends));
}

async function testDoubaoHostile() {
  console.log('\n[7] 豆包（站点无视合成事件、且不认 Shift+Enter）：两条兜底路径');
  await page.goto(DOUBAO + '?hostile=1');
  await page.inject();
  await page.focus('#editor');
  await page.type('兜底');
  await page.pressEnter();
  let s = await page.eval('window.__state()');
  check('合成 Shift+Enter 无效时，改用 execCommand 完成换行',
    /<br\s*\/?>/i.test(s.html) || s.text.includes('\n'), JSON.stringify(s));
  check('兜底换行没有触发发送', s.sends.length === 0, JSON.stringify(s.sends));

  await page.pressEnter({ ctrl: true });
  s = await page.eval('window.__state()');
  check('合成回车无效时，改用点击发送按钮完成发送', s.sends.length === 1, JSON.stringify(s.sends));
}

async function testShadowDom() {
  console.log('\n[9] DeepSeek（输入框被包进 shadow DOM）：仍然能识别并接管');
  await page.goto(SHADOW);
  await page.inject();
  check('脚本已加载', await page.eval('window.__enterToNewlineLoaded === true'), '未加载');

  await page.focusShadow();
  await page.type('影子');
  await page.pressEnter();
  let s = await page.eval('window.__state()');
  check('Enter 在 shadow DOM 里的输入框插入了换行', s.text === '影子\n', JSON.stringify(s));
  check('Enter 没有触发发送', s.sends.length === 0, JSON.stringify(s.sends));
  check('站点没收到这个回车（说明拦到了 shadow root 里面的元素）', s.seenBySite === 0, JSON.stringify(s));

  await page.pressEnter({ ctrl: true });
  s = await page.eval('window.__state()');
  check('Ctrl+Enter 触发了发送', s.sends.length === 1, JSON.stringify(s.sends));
}

async function testShadowDomHostile() {
  console.log('\n[10] shadow DOM + 站点无视合成事件：发送按钮要能从 shadow root 里找到');
  await page.goto(SHADOW + '?hostile=1');
  await page.inject();
  await page.focusShadow();
  await page.type('穿透');
  await page.pressEnter({ ctrl: true });
  const s = await page.eval('window.__state()');
  check('站点没收到这个 Ctrl+Enter（被脚本在捕获阶段拦下）', s.seenBySite === 0, JSON.stringify(s));
  check('点到了 shadow root 内部的发送按钮（走的是点按钮兜底）', s.buttonClicks === 1, JSON.stringify(s));
  check('消息确实发出去了', s.sends.length === 1 && s.sends[0] === '穿透', JSON.stringify(s.sends));
}

async function testToggleOff() {
  console.log('\n[8] 开关：关掉接管后恢复站点原生行为');
  await page.goto(DEEPSEEK);
  await page.inject();
  check('控制台 API 可用', await page.eval('typeof window.__enterToNewline.status === "function"'), '不可用');
  await page.eval('window.__enterToNewline.disable()');
  await page.focus('#chat-input');
  await page.type('原生行为');
  await page.pressEnter();
  const s = await page.eval('window.__state()');
  check('接管关闭后，Enter 恢复为发送', s.sends.length === 1 && s.sends[0] === '原生行为', JSON.stringify(s));

  await page.eval('window.__enterToNewline.enable()');
  await page.type('重新开启');
  await page.pressEnter();
  const s2 = await page.eval('window.__state()');
  check('重新开启后，Enter 又变回换行', s2.text === '重新开启\n', JSON.stringify(s2));
}

/* ───────────────────────── 跑测试 ───────────────────────── */

const scenarios = [
  testDeepSeekBasic,
  testDeepSeekShiftEnter,
  testDeepSeekLockedNativeInsert,
  testDeepSeekModalNotHijacked,
  testDeepSeekIme,
  testDoubaoBasic,
  testDoubaoHostile,
  testShadowDom,
  testShadowDomHostile,
  testToggleOff,
];

try {
  console.log('开始验证（本地 Chrome + CDP，域名已解析到 mock 站点）');
  const only = process.env.ETN_FILTER || '';
  if (only) console.log(`（只跑匹配 "${only}" 的用例）`);
  for (const fn of scenarios) {
    if (only && !fn.name.toLowerCase().includes(only.toLowerCase())) continue;
    try {
      await fn();
    } catch (e) {
      failed++;
      console.log(`  ✗ 用例异常: ${e.message}`);
    }
  }
} finally {
  try { ws.close(); } catch { /* ignore */ }
  chrome.kill();
  server.close();
  await sleep(300);
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n结果：${results.length - failed} / ${results.length} 项通过`);
if (failed) {
  console.log('存在失败项 ✗');
  process.exitCode = 1;
} else {
  console.log('全部通过 ✓');
}
