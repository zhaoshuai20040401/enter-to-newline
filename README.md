# Enter = 换行，Ctrl+Enter = 发送（DeepSeek + 豆包 网页版）

把 DeepSeek 网页版（`chat.deepseek.com`）和豆包网页版（`www.doubao.com`）的输入框改成：

| 按键 | 行为 |
|---|---|
| `Enter` | 换行 |
| `Ctrl + Enter`（macOS 上 `Cmd + Enter` 也行） | 发送 |
| `Shift + Enter` | 换行（原生行为，保持不动） |
| 输入法组合中按回车 | 完全不接管，照常选字/上屏 |

---

## 一、先说调研结论：为什么最后是「自己写」

我把 GitHub、Greasy Fork、Chrome 应用商店里能搜到的方案都看了一遍，候选有这几个：

| 项目 | 形态 | 覆盖站点 | 评价 |
|---|---|---|---|
| [ChatGPT-Ctrl-Enter-Sender](https://github.com/masachika-kamada/ChatGPT-Ctrl-Enter-Sender)（MIT，2.5k★ 级别，有 Playwright 测试） | Chrome/Firefox 扩展，[商店可装](https://chromewebstore.google.com/detail/chat-ai-ctrl+enter-sender/gbncgdhklmnckojlibfhdadpfbcdbnch) | **含 DeepSeek**，但**不含豆包** | 质量最高的一个。按站点配置、处理了各站点的 DOM 差异，代码和测试都很规范 |
| [AI Enter as Newline](https://greasyfork.org/zh-CN/scripts/531913-ai-enter-as-newline)（MIT） | 油猴脚本 | **含 DeepSeek**，含 ChatGPT/Claude/Gemini 等十几个，**不含豆包** | 能用，但 25KB 里一大半是设置面板 UI，核心逻辑反而不好维护 |
| [universal-ai-enter-swap](https://github.com/maxiee/universal-ai-enter-swap)（MIT） | 油猴脚本 | **只有豆包** | 思路源自 [uglee《拦截豆包的回车键》](https://segmentfault.com/a/1190000046648160)。README 说"后续扩展更多平台"，但实际仍只支持豆包；实现里有个 `100ms 内有输入就跳过接管` 的启发式判断，会导致正常打字后按回车**不被拦截、消息直接被发出去**，方向是反的 |
| [Chat Ctrl+Enter Sender](https://chromewebstore.google.com/detail/chat-ctrl+enter-sender/naiinhmdiilkffilbmeinjjagjdiphme) / [EnterKeyMaster](https://chromewebstore.google.com/detail/enterkeymaster/ndnoomhongebiicbeighmimhhokfcdfe) 等商店扩展 | 扩展 | 不明确/不含豆包 | 闭源为主，无法确认行为 |

**结论：没有任何一个现成方案同时覆盖「DeepSeek + 豆包」。** 三条路各自的代价：

- **直接用商店扩展**：DeepSeek 立刻解决，但豆包还是老样子。你还是得为豆包再装一个油猴脚本 → 两个东西、行为不一致、以后各自失效。而且扩展本身还是"没覆盖豆包"。
- **Fork 那个扩展加豆包**：代码质量最好，但要 Chrome 开发者模式加载、要跟着上游同步、还得改它的 `manifest.json` / `site-configs.js` / 测试，维护成本明显高于需求本身（我们只要两个站点）。
- **自己写一个单文件脚本**：核心逻辑只有 200 行左右，两个站点一处维护，油猴脚本和免安装扩展两份产物由同一份源码生成。我选了这条，但**关键实现抄的是成熟项目验证过的做法**，不是从零拍脑袋：

  - 用 **`window` 捕获阶段**拦 `keydown`（比挂 `document` 更早，React 17+ 的事件委托挂在根容器上，一定拦得住）；
  - 用 **`isTrusted` 过滤自己派发的合成事件**，避免二次拦截；
  - 换行优先**交回浏览器/编辑器原生实现**，自己拼 DOM 是最后手段；
  - 发送优先**派发合成回车走站点自己的发送逻辑**，不认才退化为点发送按钮。

一句话：**"用现成项目的技术，自己写一份贴合这两个站点的实现"**。

### 关于两个站点的实际键位（有个发现）

- **豆包**：按 uglee 对豆包的分析，**豆包原生 `Ctrl+Enter` 本来就是发送**（他那个脚本只拦了普通回车，`Ctrl+Enter` 是站点自己处理的）。所以你描述的"Ctrl+Enter 换行"可能是和 `Shift+Enter` 记混了 —— 不过没关系，本脚本两种写法都覆盖：最终效果就是你要的 `Enter` 换行、`Ctrl+Enter` 发送。
- **DeepSeek**：原生是 `Enter` 发送、`Shift+Enter` 换行，所以必须完整接管。

---

## 二、安装（两种方式，选一个）

产物都在 `dist/` 下。

### 方式 A：油猴脚本（推荐）

适合 Tampermonkey / Violentmonkey / Greasemonkey 用户。

**A-1 一键安装（从 GitHub，推荐）**

先装 [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)，然后打开这个链接：

```
https://raw.githubusercontent.com/zhaoshuai20040401/enter-to-newline/main/dist/enter-to-newline.user.js
```

油猴会自动弹出安装页，点「安装」即可。这样装的好处是**自带自动更新** —— 仓库里发了新版本，油猴会自己检查并提示升级（脚本头里写了 `@downloadURL` / `@updateURL`）。

**A-2 手动安装（复制粘贴）**

1. 打开 Tampermonkey → 管理面板 → 点 `+` 添加新脚本
2. **先把编辑器里的模板代码全选删掉**（Ctrl+A → Delete），再粘贴 **`dist/enter-to-newline.user.js`** 的内容
3. 保存（Ctrl+S）
4. 刷新 DeepSeek / 豆包页面

> ⚠️ 如果你之前用「复制粘贴」装过一版，请先在油猴面板里把**旧的那个删掉**再装新的：脚本的 `@namespace` 已经从 `https://local/...` 改成了 GitHub 仓库地址，油猴会把两者当成不同脚本，同时启用会互相干扰。


### 方式 B：免安装 Chrome/Edge 扩展

不想装脚本管理器就用这个。扩展**不需要任何权限声明**（没有 `permissions`、没有后台脚本）。

1. 打开 `chrome://extensions/`（Edge 是 `edge://extensions/`）
2. 打开右上角 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本项目的 **`dist/extension`** 文件夹
4. 刷新 DeepSeek / 豆包页面

### 两种方式怎么选

| | 油猴脚本 | 免安装扩展 |
|---|---|---|
| 前置 | 要先装 Tampermonkey | 无，但要开开发者模式 |
| 更新 | 重新粘贴文件 | 替换 `content.js` 后点刷新 |
| 浏览器提示 | 无 | 开发者模式会有提示条 |

---

## 三、开关和排错

脚本默认开启。所有设置按站点分别记在 `localStorage` 里，互不影响。

在页面上按 `F12` 打开控制台，输入：

```js
__enterToNewline.status()      // 看当前状态
__enterToNewline.disable()     // 临时关掉，恢复站点原生行为
__enterToNewline.enable()      // 再打开
__enterToNewline.debug(true)   // 打开调试日志，之后每次按键都会打印判断过程
__enterToNewline.showBadge()   // 在右下角显示一个可点击的悬浮开关
```

调试日志长这样，能直接看出脚本有没有拦到：

```
[Enter换行] Enter → 换行
[Enter换行] 原生/编辑器换行未生效，执行兜底插入
[Enter换行] Ctrl/Cmd+Enter → 发送
```

**如果站点改版导致失效**，最省事的做法是 `__enterToNewline.showBadge()`，右下角会出现一个开关，点一下就能立刻切回原生行为，不用去卸载脚本。

---

## 四、我验证了什么

`node test/run.mjs` —— 用本机 Chrome + CDP 驱动两个 mock 站点（把 `chat.deepseek.com` / `www.doubao.com` 用 `--host-resolver-rules` 解析到本地服务，所以**站点匹配逻辑是真跑的**），发的是 `isTrusted=true` 的真实按键事件。**29 项全部通过**：

```
[1] DeepSeek（React 受控 textarea）：Enter 换行、Ctrl+Enter 发送       8/8
[2] DeepSeek：Shift+Enter 保持原生换行                                2/2
[3] DeepSeek（站点禁止浏览器原生插入换行）：走兜底插入路径            2/2
[4] DeepSeek：弹窗里的输入框不被接管                                  1/1
[5] DeepSeek：输入法组合期间不接管回车                                5/5
[6] 豆包（contenteditable 编辑器）：Enter 换行、Ctrl+Enter 发送       5/5
[7] 豆包（站点无视合成事件、且不认 Shift+Enter）：两条兜底路径        3/3
[8] 开关：关掉接管后恢复站点原生行为                                  3/3
```

覆盖的关键场景：

- React 受控组件下换行**不会被重绘回滚**（用原生 value setter + `input` 事件，而不是直接改 `.value`）；
- 站点在捕获阶段之外**完全收不到**那个回车（证明拦截生效，而不是碰巧没发送）；
- 站点用 `beforeinput` 禁止了浏览器原生换行时，兜底插入仍然生效；
- 站点对合成事件免疫（检查 `isTrusted`）时，发送能退化为点击发送按钮；
- 弹窗/对话框里的输入框（比如"重命名对话"）**不会**被误接管；
- 输入法组合期间放行、组合结束后恢复接管；
- 关掉开关后能干净地回到站点原生行为。

### 需要说明的两个局限

1. **我没法登录真实站点实测。** 上面是 mock 复刻的行为（受控 textarea / contenteditable 编辑器 / beforeinput 拦截 / isTrusted 免疫），真实站点的 DOM 我按现有资料配置了选择器，并且都留了"站点改版后依然认得出输入框"的兜底判定。如果你实测有问题，开一下 `debug(true)` 把日志发我，基本都是加一个选择器的事。
2. **`test/run.mjs` 里加了 `--no-proxy-server`。** 因为这台机器上 Chrome 走了系统代理，不加的话 mock 域名会被代理拦掉。这是测试脚本的事，和正式产物无关。

---

## 五、文件结构

```
enter-to-newline/
├─ src/enter-swap.js                # 核心逻辑（唯一真源，带详细注释）
├─ build.mjs                        # 一份源码 → 两种产物
├─ package.json                     # npm run build / npm test
├─ LICENSE                          # MIT
├─ dist/
│  ├─ enter-to-newline.user.js      # 产物：油猴脚本（下载/安装用这个）
│  └─ extension/                    # 产物：Chrome MV3 免安装扩展
│     ├─ manifest.json
│     └─ content.js
├─ mock/                            # 测试用 mock 站点
│  ├─ deepseek.html                 # 受控 textarea + 弹窗输入框
│  └─ doubao.html                   # contenteditable 编辑器（?hostile=1 走最坏情况）
└─ test/run.mjs                     # 零依赖自动化验证（本机 Chrome + CDP）
```

改代码的流程：改 `src/enter-swap.js` → `npm run build` → `npm test`。

### 发布新版本（让已安装的用户自动升级）

```bash
# 1. 改 build.mjs 里的 META.version，比如 1.0.0 → 1.0.1
# 2. 重新构建 + 验证
npm test
# 3. 提交并推送
git add -A && git commit -m "fix: xxx" && git push
```

推送后，油猴会在下次检查更新时自动拉到新版本（也可以手动在油猴面板点「检查更新」）。如果换了 GitHub 账号或仓库名，改 `build.mjs` 顶部的 `OWNER` / `REPO`，或者用环境变量 `GITHUB_OWNER` / `GITHUB_REPO` 覆盖。


### 想再加一个站点

在 `src/enter-swap.js` 的 `SITES` 里加一条就行：

```js
{
  id: 'kimi',
  label: 'Kimi',
  hosts: ['www.kimi.com'],
  composer: ['div[contenteditable="true"][data-lexical-editor="true"]'],
  sendButton: ['button[type="submit"]']
}
```

然后 `build.mjs` 里的 `META.matches` 加一条 `https://www.kimi.com/*`，重新 build。`composer` 和 `sendButton` 都匹配不上时会走兜底逻辑，所以选择器不需要写得很完美。

---

## 六、实现要点（给以后维护的自己看）

1. **为什么挂在 `window` 捕获阶段**：事件路径是 `window → document → … → 输入框`，React 17+ 的委托监听在根容器上，挂 `window` 捕获才能保证永远比站点先拿到事件。配合 `stopImmediatePropagation()` 拦掉站点的"回车 = 发送"。
2. **textarea 换行不调 `preventDefault()`**：让浏览器自己插入换行并派发 `input` 事件，受控组件会据此更新 state。只有 `contenteditable` 才 `preventDefault()` + 派发合成 `Shift+Enter`，因为直接改编辑器的 DOM 会让 Lexical/ProseMirror 这类编辑器的内部模型和 DOM 不一致，随后被它自己重绘覆盖。
3. **兜底插入用原型上的原生 setter**：直接 `el.value = x` 会被 React/Vue 的 setter 覆盖绕过，state 不更新，下次重绘就把换行抹掉。
4. **换行后会复查一次**：下一帧检查真的换行了没，没成功就兜底插入；再隔 120ms 看看有没有被站点异步回滚，被回滚就再插一次。
5. **发送优先用合成回车**：让站点自己的发送逻辑跑（这样附带状态、埋点、按钮禁用判断都是站点的），`80ms` 后如果输入框没被清空才退化为点发送按钮。
6. **输入法只认 `isComposing` / `keyCode === 229`，刻意不做"组合结束后 N 毫秒内也跳过"的宽限**：漏拦一次回车会让消息被发出去（正是我们要避免的事故），而多插一个换行只是小麻烦 —— 出错方向必须偏向"拦"。
