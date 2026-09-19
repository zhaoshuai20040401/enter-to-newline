// ==UserScript==
// @name         Enter 换行 / Ctrl+Enter 发送（DeepSeek + 豆包）
// @name:en      Enter = Newline, Ctrl+Enter = Send (DeepSeek + Doubao)
// @namespace    https://github.com/zhaoshuai20040401/enter-to-newline
// @version      1.0.1
// @description  把 DeepSeek、豆包网页版的回车键改成换行，Ctrl/Cmd+Enter 才发送消息。
// @description:en Swap Enter/Ctrl+Enter on DeepSeek and Doubao web chat.
// @author       zhaoshuai20040401
// @license      MIT
// @homepageURL  https://github.com/zhaoshuai20040401/enter-to-newline
// @supportURL   https://github.com/zhaoshuai20040401/enter-to-newline/issues
// @downloadURL  https://raw.githubusercontent.com/zhaoshuai20040401/enter-to-newline/main/dist/enter-to-newline.user.js
// @updateURL    https://raw.githubusercontent.com/zhaoshuai20040401/enter-to-newline/main/dist/enter-to-newline.user.js
// @match        https://chat.deepseek.com/*
// @match        https://www.doubao.com/*
// @match        https://doubao.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/* ============================================================================
 * Enter = 换行，Ctrl/Cmd + Enter = 发送
 * 目标站点：DeepSeek 网页版（chat.deepseek.com）、豆包网页版（www.doubao.com）
 *
 * 这是唯一真源（single source of truth）。build.mjs 会把它分别打包成：
 *   dist/enter-to-newline.user.js   油猴脚本（Tampermonkey / Violentmonkey）
 *   dist/extension/content.js       Chrome MV3 内容脚本
 *
 * 设计要点（为什么这么做，而不是简单地 preventDefault + 手动插入）：
 *
 * 1. 捕获阶段拦截 window 上的 keydown。
 *    事件传播路径是 window → document → html → ... → 输入框。
 *    React 17+ 把事件委托挂在根容器上，site 自己的监听器也在输入框或容器上，
 *    因此 window 捕获阶段一定比它们更早，可以拦掉站点「回车 = 发送」的逻辑。
 *
 * 2. 换行尽量交回给浏览器/编辑器原生实现，而不是自己拼 HTML。
 *    - textarea：只 stopImmediatePropagation()，**不** preventDefault。
 *      浏览器的原生换行会照常插入，并自动派发 input 事件，
 *      受控组件（React/Vue）据此更新自己的 state，不会把换行回滚掉。
 *    - contenteditable：preventDefault() 后派发一个合成的 Shift+Enter，
 *      走编辑器自己的换行命令 —— 直接改 DOM 会让 Lexical / ProseMirror
 *      这类编辑器的内部模型和 DOM 不一致，随后被它自己重绘覆盖。
 *    两种路径都会在下一帧检查是否真的换行了，没成功才走兜底插入。
 *
 * 3. 发送优先派发一个合成的「普通 Enter」，让站点自己的发送逻辑跑；
 *    若站点不认合成事件（有些实现会检查 isTrusted），再退化为点击发送按钮。
 *
 * 4. 只处理 isTrusted 的真实按键，因此自己派发的合成事件不会被二次拦截。
 *
 * 5. 输入法（中文/日文/韩文）组合期间一律不接管，否则会抢掉选字的回车。
 *    注意这里刻意不做「组合结束后 N 毫秒内也跳过」的宽限：
 *    漏拦一次回车会让消息被发出去（正是我们想避免的事故），
 *    而多插一个换行只是小麻烦 —— 出错方向要偏向「拦」。
 * ==========================================================================*/
(function () {
  'use strict';

  if (window.__enterToNewlineLoaded) return;
  window.__enterToNewlineLoaded = true;

  var VERSION = '1.0.1';
  var PREFIX = '[Enter换行]';
  var KEY_ENABLED = 'enter-to-newline:enabled:';   // 按站点分别记忆开关
  var KEY_DEBUG = 'enter-to-newline:debug';
  var KEY_BADGE = 'enter-to-newline:badge';
  var SEND_FALLBACK_DELAY = 80;                   // 合成回车后等多久才判定「没发出去」
  var REVERT_CHECK_DELAY = 120;                   // 兜底插入后，隔多久复查是否被站点回滚
  var NO_SWAP_SELECTOR = '[data-enter-swap="off"]';

  /* ────────────────────────── 站点配置 ────────────────────────── */

  var SITES = [
    {
      id: 'deepseek',
      label: 'DeepSeek',
      hosts: ['chat.deepseek.com'],
      // 优先用这些选择器认出「聊天输入框」；一个都匹配不上时走兜底判定
      composer: [
        'textarea#chat-input',
        'textarea[data-testid="chat-input"]',
        'textarea[class*="chat-input"]'
      ],
      sendButton: [
        'div[role="button"][aria-disabled="false"]',
        '[data-testid="chat-input-send-button"]',
        '[data-testid="send-button"]'
      ]
    },
    {
      id: 'doubao',
      label: '豆包',
      hosts: ['www.doubao.com', 'doubao.com'],
      composer: [
        'textarea[data-testid="chat_input_input"]',
        'div[data-testid="chat_input_input"]',
        'textarea[data-testid="chat_input"]',
        'div[data-testid="chat_input"]',
        'div[contenteditable="true"][role="textbox"]'
      ],
      sendButton: [
        'button[data-testid="chat_input_send_button"]',
        '[data-testid="chat_input_send_icon"]',
        'button[aria-label*="发送"]',
        'button[title*="发送"]'
      ]
    }
  ];

  /* ────────────────────────── 基础设施 ────────────────────────── */

  var store = (function () {
    // 优先 localStorage（油猴 @grant none 与扩展内容脚本都能直接用）
    try {
      var t = '__etn_test__';
      window.localStorage.setItem(t, '1');
      window.localStorage.removeItem(t);
      return window.localStorage;
    } catch (e) {
      var mem = {};
      return {
        getItem: function (k) { return k in mem ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); }
      };
    }
  })();

  function readFlag(key, dflt) {
    try { var v = store.getItem(key); return v === null ? dflt : v === '1'; } catch (e) { return dflt; }
  }
  function writeFlag(key, val) {
    try { store.setItem(key, val ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  var debug = readFlag(KEY_DEBUG, false);

  function log() {
    if (!debug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift(PREFIX);
    console.log.apply(console, args);
  }

  // 找到当前站点配置；不在目标站点就直接退出，零开销
  var site = null;
  for (var i = 0; i < SITES.length; i++) {
    if (SITES[i].hosts.indexOf(location.hostname) !== -1) { site = SITES[i]; break; }
  }
  if (!site) {
    window.__enterToNewlineLoaded = false;
    return;
  }

  var enabled = readFlag(KEY_ENABLED + site.id, true);

  /* ────────────────────────── 输入框判定 ────────────────────────── */

  function isVisible(el) {
    try { return !!(el.getClientRects && el.getClientRects().length); } catch (e) { return false; }
  }

  function insideModal(el) {
    try { return !!(el.closest && el.closest('[role="dialog"],[aria-modal="true"]')); } catch (e) { return false; }
  }

  function isComposer(el) {
    if (!el || el.nodeType !== 1) return false;

    var isTextarea = el.tagName === 'TEXTAREA';
    var isEditable = el.isContentEditable === true;

    if (!isTextarea && !isEditable) return false;
    if (isTextarea && (el.disabled || el.readOnly)) return false;
    if (el.getAttribute('contenteditable') === 'false') return false;
    if (!isVisible(el)) return false;

    // 逃生舱：任何祖先/自身带 data-enter-swap="off" 就不接管
    try { if (el.closest(NO_SWAP_SELECTOR)) return false; } catch (e) { /* ignore */ }

    for (var i = 0; i < site.composer.length; i++) {
      try { if (el.matches(site.composer[i])) return true; } catch (e) { /* 忽略非法选择器 */ }
    }

    // 兜底：站点改版导致选择器失效时，仍然接管页面上可见的输入区，
    // 但排除弹窗/对话框里的输入框（改名、搜索之类，回车另有语义）。
    return !insideModal(el);
  }

  /* ────────────────────────── 读写输入框内容 ────────────────────────── */

  function isTextarea(el) { return el.tagName === 'TEXTAREA'; }

  function textOf(el) {
    return isTextarea(el) ? el.value : (el.innerText || el.textContent || '');
  }

  function snap(el) {
    return isTextarea(el) ? el.value : el.innerHTML;
  }

  function dispatchKey(el, opts) {
    var init = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    };
    if (opts) for (var k in opts) init[k] = opts[k];
    el.dispatchEvent(new KeyboardEvent('keydown', init));
  }

  // 直接写 value 会绕过 React/Vue 的 setter 覆盖，state 不会更新，
  // 下次重绘就把我们插的换行抹掉。必须走原型上的原生 setter。
  function insertTextareaNewline(el) {
    var start = el.selectionStart, end = el.selectionEnd;
    if (typeof start !== 'number') { start = end = el.value.length; }
    var next = el.value.slice(0, start) + '\n' + el.value.slice(end);

    var desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, next); else el.value = next;

    try { el.selectionStart = el.selectionEnd = start + 1; } catch (e) { /* ignore */ }
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertLineBreak', data: '\n'
    }));
  }

  function insertEditableNewline(el) {
    var ok = false;
    try { ok = document.execCommand('insertLineBreak'); } catch (e) { ok = false; }
    if (!ok) { try { ok = document.execCommand('insertText', false, '\n'); } catch (e2) { ok = false; } }
    if (ok) return;

    // 最后一招：直接操作 Range
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    range.deleteContents();
    var br = document.createElement('br');
    range.insertNode(br);
    range.setStartAfter(br);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertLineBreak', data: '\n'
    }));
  }

  function doInsertNewline(el) {
    if (isTextarea(el)) insertTextareaNewline(el);
    else insertEditableNewline(el);
  }

  // 换行处理完的下一帧检查结果；没生效（或被站点异步回滚）就自己插入
  function verifyThenMaybeInsert(el, before) {
    window.setTimeout(function () {
      if (snap(el) !== before) return;
      log('原生/编辑器换行未生效，执行兜底插入');
      doInsertNewline(el);
      window.setTimeout(function () {
        if (snap(el) === before) {
          log('兜底插入被站点回滚，再插一次');
          doInsertNewline(el);
        }
      }, REVERT_CHECK_DELAY);
    }, 0);
  }

  /* ────────────────────────── 发送 ────────────────────────── */

  function clickable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.hasAttribute('disabled')) return false;
    return isVisible(el);
  }

  // 在输入框所在的 DOM 作用域里查找。输入框如果在 shadow DOM 内，
  // 发送按钮多半也在同一个 shadow root 里，document.querySelectorAll 是找不到的。
  function queryAllScopes(el, selector) {
    var out = [], roots = [];
    try {
      var r = el.getRootNode && el.getRootNode();
      if (r) roots.push(r);
    } catch (e) { /* ignore */ }
    if (roots.indexOf(document) === -1) roots.push(document);

    for (var i = 0; i < roots.length; i++) {
      try {
        var list = roots[i].querySelectorAll(selector);
        for (var j = 0; j < list.length; j++) {
          if (out.indexOf(list[j]) === -1) out.push(list[j]);
        }
      } catch (e) { /* 忽略非法选择器 */ }
    }
    return out;
  }

  function findSendButton(el) {
    var i, j, nodes;

    // 1) 站点已知选择器
    for (i = 0; i < site.sendButton.length; i++) {
      nodes = queryAllScopes(el, site.sendButton[i]);
      for (j = 0; j < nodes.length; j++) {
        var b = nodes[j].closest('button,[role="button"]') || nodes[j];
        if (clickable(b)) return b;
      }
    }

    // 2) 语义匹配（aria-label / title / data-testid / 文本）
    nodes = queryAllScopes(el, 'button,[role="button"]');
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!clickable(n)) continue;
      var label = (n.getAttribute('aria-label') || '') + ' ' +
                  (n.getAttribute('title') || '') + ' ' +
                  (n.getAttribute('data-testid') || '') + ' ' +
                  (n.textContent || '');
      if (/(send|发送)/i.test(label)) return n;
    }

    // 3) 启发式：输入框所在容器内、最靠右、带图标且可点击的元素
    var box = el.closest('form') || el.parentElement;
    for (var depth = 0; box && depth < 4; depth++, box = box.parentElement) {
      var cands = box.querySelectorAll('button,[role="button"]');
      var best = null, bestX = -Infinity;
      for (i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (!clickable(c)) continue;
        if (!c.querySelector('svg')) continue;
        var r = c.getBoundingClientRect();
        if (r.left > bestX) { bestX = r.left; best = c; }
      }
      if (best) return best;
    }
    return null;
  }

  function send(el) {
    var before = textOf(el).trim();
    if (before === '') { log('输入框为空，不发送'); return; }

    log('派发合成回车以触发站点发送');
    dispatchKey(el, {});

    window.setTimeout(function () {
      var now = textOf(el).trim();
      if (now !== before) { log('站点已发送'); return; }
      var btn = findSendButton(el);
      if (btn) { log('合成回车未生效，改点发送按钮', btn); btn.click(); }
      else log('合成回车与发送按钮都没生效');
    }, SEND_FALLBACK_DELAY);
  }

  /* ────────────────────────── 换行 ────────────────────────── */

  function newline(el, event) {
    if (textOf(el).trim() === '') {
      // 空输入框：站点此时发送按钮多半是禁用的，什么都不做更贴近原生表现
      log('输入框为空，忽略回车');
      return;
    }

    var before = snap(el);
    event.stopImmediatePropagation();   // 拦掉站点「回车 = 发送」

    if (isTextarea(el)) {
      // 不 preventDefault：浏览器原生插入换行 + 自动派发 input 事件
      verifyThenMaybeInsert(el, before);
    } else {
      // 编辑器：交给它自己的换行逻辑，避免 DOM 与内部模型不一致
      event.preventDefault();
      dispatchKey(el, { shiftKey: true });
      verifyThenMaybeInsert(el, before);
    }
  }

  /* ────────────────────────── 主监听 ────────────────────────── */

  var composing = false;

  function isEnterKey(event) {
    return event.key === 'Enter' || event.code === 'Enter' ||
           event.code === 'NumpadEnter' || event.keyCode === 13;
  }

  // 取真正被按下的元素。输入框如果以后被站点挪进 shadow DOM，
  // window 捕获阶段拿到的 event.target 会是 shadow 宿主（外层自定义元素），
  // 而 composedPath()[0] 才是里面那个真正的可编辑元素。
  function realTarget(event) {
    if (typeof event.composedPath === 'function') {
      var path = event.composedPath();
      if (path && path.length && path[0] && path[0].nodeType === 1) return path[0];
    }
    return event.target;
  }

  function onKeyDown(event) {
    if (!enabled) return;
    if (!event.isTrusted) return;                                  // 自己派发的合成事件
    if (!isEnterKey(event)) return;
    if (event.altKey) return;
    if (event.isComposing || composing || event.keyCode === 229) {  // 输入法组合中
      log('输入法组合中，跳过');
      return;
    }

    var el = realTarget(event);
    if (!isComposer(el)) return;

    if (event.ctrlKey || event.metaKey) {
      log('Ctrl/Cmd+Enter → 发送');
      event.preventDefault();
      event.stopImmediatePropagation();
      send(el);
      return;
    }
    if (event.shiftKey) return;   // Shift+Enter 本来就是换行，放行

    log('Enter → 换行');
    newline(el, event);
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('compositionstart', function () { composing = true; }, true);
  window.addEventListener('compositionend', function () { composing = false; }, true);

  /* ────────────────────────── 开关 / 调试 ────────────────────────── */

  function setEnabled(next) {
    enabled = !!next;
    writeFlag(KEY_ENABLED + site.id, enabled);
    log(site.label + ' 接管已' + (enabled ? '开启' : '关闭'));
    if (badgeEl) renderBadge();
    return enabled;
  }

  function setDebug(next) {
    debug = !!next;
    writeFlag(KEY_DEBUG, debug);
    log('调试日志已' + (debug ? '开启' : '关闭'));
    return debug;
  }

  /* 可选的悬浮开关（默认关闭）。开了之后如果站点改版失效，
     用户点一下就能立刻切回原生行为，不用去打开控制台。 */
  var badgeEl = null, badgeRoot = null;

  function renderBadge() {
    if (!badgeEl) return;
    badgeEl.textContent = enabled ? '↵ 换行 · Ctrl+↵ 发送' : '↵ 已关闭（原生行为）';
    badgeEl.style.background = enabled ? 'rgba(22,163,74,.92)' : 'rgba(120,120,120,.92)';
  }

  function showBadge() {
    if (badgeEl) return;
    badgeRoot = document.createElement('div');
    badgeRoot.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:2147483647';
    var root = badgeRoot.attachShadow ? badgeRoot.attachShadow({ mode: 'open' }) : badgeRoot;
    badgeEl = document.createElement('button');
    badgeEl.type = 'button';
    badgeEl.style.cssText = [
      'font:12px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif',
      'color:#fff', 'border:0', 'border-radius:999px', 'padding:4px 10px',
      'cursor:pointer', 'opacity:.75', 'box-shadow:0 2px 8px rgba(0,0,0,.25)'
    ].join(';');
    badgeEl.addEventListener('click', function () { setEnabled(!enabled); });
    root.appendChild(badgeEl);
    (document.body || document.documentElement).appendChild(badgeRoot);
    renderBadge();
  }

  function hideBadge() {
    if (badgeRoot && badgeRoot.parentNode) badgeRoot.parentNode.removeChild(badgeRoot);
    badgeRoot = null;
    badgeEl = null;
  }

  if (readFlag(KEY_BADGE, false)) showBadge();

  // 控制台 API（本脚本 @grant none，直接跑在页面上下文里）
  window.__enterToNewline = {
    version: VERSION,
    site: site.id,
    status: function () {
      console.log(PREFIX + ' v' + VERSION + ' 站点=' + site.label +
        ' 接管=' + (enabled ? '开' : '关') +
        ' 调试=' + (debug ? '开' : '关') +
        ' 悬浮开关=' + (badgeEl ? '开' : '关'));
      return { version: VERSION, site: site.id, enabled: enabled, debug: debug, badge: !!badgeEl };
    },
    enable: function () { return setEnabled(true); },
    disable: function () { return setEnabled(false); },
    toggle: function () { return setEnabled(!enabled); },
    debug: function (on) { return setDebug(on === undefined ? !debug : on); },
    showBadge: function () { writeFlag(KEY_BADGE, true); showBadge(); },
    hideBadge: function () { writeFlag(KEY_BADGE, false); hideBadge(); }
  };

  log('已加载 v' + VERSION + ' 站点=' + site.label + ' 接管=' + (enabled ? '开' : '关'));
})();
