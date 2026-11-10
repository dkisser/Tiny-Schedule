# dsh 版本升级指南

本文档记录 Tiny-Schedule 这个 dsh 插件在跟进 dsh 版本时的检查项、踩过的坑，以及可复现的验证方法。

适用范围：`packages/dsh-plugin`（宿主半边 + 浏览器半边）。

dsh 处于 developer preview，版本迭代快、破坏性变更多，且**没有官方迁移指南**。这份文档就是替代品——升级前照着走一遍，比升级后再 debug 省事。

---

## 0. 为什么要升级

dsh 会在装插件时做**版本闸门**：插件 `peerDependencies` 里声明的 `@deepseek-ai/dsh-*` 版本必须与运行中的 dsh 版本一致，否则直接拒绝安装：

```
$ dsh plugin --profile web add ./packages/dsh-plugin
dsh: installation rejected: Plugin dsh-plugin-tiny-schedule@0.1.0 is incompatible
with dsh 0.2.2-rc.1: requirements {...}
dsh: nothing was installed.
```

所以升 dsh 不是可选项——dsh 一升，插件就必须跟着升。

> **逃生舱**：`dsh plugin --profile web allow-version <pkg>@<ver> --dsh-version <ver> --accept-risk` 可以跳过闸门。仅在确认新旧 API 完全兼容时使用；本项目没用过，升级一律走正经路径。

---

## 1. 升级前的准备

```bash
# 当前 dsh 版本
dsh --version

# npm 上有哪些版本可选
npm view @deepseek-ai/dsh versions --json
npm view @deepseek-ai/dsh dist-tags
```

本项目当前锚定 `0.2.2-rc.1`。

### 全局安装

```bash
npm install -g @deepseek-ai/dsh@0.2.2-rc.1
dsh --version
```

**坑（npm 11+）**：npm 11 默认不执行依赖的安装脚本，`node-pty` 等原生模块会缺少构建产物，运行时报错。补一次：

```bash
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
  @deepseek-ai/dsh@0.2.2-rc.1
```

安装输出里出现 `npm warn install-scripts ... not yet covered by allowScripts` 就说明脚本没跑，必须补。

### 依赖管理工具

`dsh plugin add` 内部转发给 **pnpm**，PATH 里没有 pnpm 会直接失败：

```
Command failed with ENOENT: pnpm add /path/to/packages/dsh-plugin
spawn pnpm ENOENT
```

```bash
npm install -g pnpm
pnpm --version
```

---

## 2. 升级插件依赖

插件的 `packages/dsh-plugin/package.json` 里有三处版本要一起改：

| 位置 | 字段 | 目标 |
| --- | --- | --- |
| `peerDependencies` | `@deepseek-ai/dsh-*` | 与新 dsh 版本**逐字相同** |
| `peerDependenciesMeta` | 同上各项 | `optional: true`（宿主可能不提供） |
| `devDependencies` | 同上各项 | 同 peer 版本，用于本地 typecheck |

`@deepseek-ai/cordis` 的 peer 范围用 `^4.1.0` 这样的宽松区间即可（cordis 自己的版本跟随 dsh），但 devDependency 要钉到实际装的版本。

### 坑 1：`zod` 必须与 `dsh-storage-domain` 用的完全一致

**这是最容易踩、也最难查的一个坑。**

`@deepseek-ai/dsh-storage-domain` 的 `domainTable()` 签名是：

```ts
declare function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V>;
```

`V` 要从 `ZodType<V>` 反推出来。如果插件的 schema 由 **另一个 zod 版本**构造，TypeScript 就得把两套 zod 类型图做结构化深匹配——这不会报错，而是**把堆吃光**：

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

症状迷惑性极强：报错指向 `tsc`，但源码一行没改，只是升级了依赖。`NODE_OPTIONS=--max-old-space-size=8192` 也救不回来（8GB 依然 OOM）。

最小复现（单表小 schema 就够）：

```ts
import { domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
export const t = domainTable(z.object({ id: z.string() }));
```

**dsh 0.1.0-rc.7 → 0.2.2-rc.1 正是踩中这个**：`dsh-storage-domain` 把 zod 依赖从 `^4.4.3` 改成了钉死的 `4.4.3`，而插件还是 `^4.4.3` → 解析出 4.6.7 → 两套并存 → OOM。

修复：把插件的 zod 钉到与宿主同一版本。

```json
"dependencies": {
  "zod": "4.4.3"
}
```

对齐后 typecheck 从「跑不完」变成 **0.9 秒通过**。

> 每次升级都要重新核对：`dsh-storage-domain` 的 zod 依赖范围可能又被改了。

### 坑 2：锁文件会留下旧版本的残留解析

只改 `package.json` 再 `bun install` 是不够的——旧的 `bun.lock` 会保留上一次的解析结果，造成**新旧版本混装**。实测中 `@deepseek-ai/dsh-storage`（`dsh-storage-domain` 的 peer）被解析到了 `0.1.0-rc.8`，而宿主是 `0.2.2-rc.1`。

更隐蔽的是 `bun install` 只在**警告**里告诉你：

```
warn: incorrect peer dependency "@deepseek-ai/dsh-llm@0.1.0-rc.8"
warn: incorrect peer dependency "@deepseek-ai/dsh-storage@0.1.0-rc.8"
```

解决：删干净重装。

```bash
rm -rf node_modules packages/*/node_modules bun.lock
bun install
```

干净装完的 `.bun` store 应该只有一个版本族：

```bash
ls node_modules/.bun | grep deepseek-ai
# @deepseek-ai+dsh-storage-domain@0.2.2-rc.1+...
# @deepseek-ai+dsh-storage@0.2.2-rc.1+...
```

---

## 3. 类型声明会搬家

dsh 的宿主服务类型（`ctx.slots`、`ctx.locale`、`ctx.tools`、`ctx.storageDomain`、`ctx.webServer`）不是由一个包统一声明的，而是**分散在各个包的 `declare module '@deepseek-ai/cordis'` 里**。升级时这些增强可能整体换包。

本次 0.2.x 的变化：

| 服务 | 0.1.0-rc.7 声明在 | 0.2.2-rc.1 声明在 |
| --- | --- | --- |
| `ctx.slots` | `@deepseek-ai/dsh-client-ui-conversation/client`（间接） | `@deepseek-ai/dsh-client-ui-renderer/client` |
| `ctx.locale` | `@deepseek-ai/dsh-client-locale/client` | 不变 |

`ctx.slots` 搬家后，插件里这两行直接报类型错：

```
src/client/index.ts(36,7): error TS2339: Property 'slots' does not exist on type 'Context'.
src/client/index.ts(37,9): error TS2339: Property 'slots' does not exist on type 'Context'.
```

修复：把新家加进依赖，并显式引入它的 Context 合并。

```json
"peerDependencies": {
  "@deepseek-ai/dsh-client-ui-renderer": "0.2.2-rc.1"
}
```

```ts
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
```

> 注意：宿主半边（`ctx.storageDomain` / `ctx.tools` / `ctx.webServer`）在 0.1.x → 0.2.x 之间**没有搬家**，签名也基本没变（`webServer.register({ kind: 'prefix', path, handler })` 照旧可用）。所以宿主半边的风险低于浏览器半边。

---

## 4. 声明客户端加载顺序

浏览器半边是 closure factory，靠 `package.json` 的 `dsh.client` 声明被加载器发现：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-renderer",
      "@deepseek-ai/dsh-client-ui-conversation"
    ]
  }
}
```

`inject` 列出的是**包 id**，不是服务名。它决定加载顺序；不写的话插件可能在 `ctx.slots` / `ctx.locale` 就绪前就执行 `apply()`，表现为标签页偶尔不出现。

对照 `export const inject = ['slots', 'locale']` —— 那是 cordis 层的**服务**注入，两者是不同维度，别混。

验证声明生效：

```bash
# 浏览器控制台
window.__DSH_BOOT__.entries.filter(e => e.id.includes('tiny-schedule'))
# 应看到 inject 数组
```

---

## 5. 验证清单

升级后按顺序过一遍，**每一步都要看到实际输出**，不要只看退出码。

```bash
cd packages/dsh-plugin

# 1. 类型（务必看是否秒级完成；变慢=OOM 前兆）
time ./node_modules/.bin/tsc --noEmit

# 2. 测试
bun test

# 3. 构建
bun run build

# 4. 全仓
cd ../.. && bun run lint && bun run typecheck && bun run test
```

装进 profile 并启动：

```bash
dsh plugin --profile web add /path/to/Tiny-Schedule/packages/dsh-plugin
dsh web --no-open
```

### 运行时探针

```bash
TOKEN=$(grep -o 'token=[^ ]*' /tmp/dsh-web.log | head -1 | cut -d= -f2)

# 插件行是否进了配置树
dsh --profile web --dump-config | grep -A3 tiny-schedule

# 宿主 API（先换 cookie）
curl -s -c /tmp/c.txt -b /tmp/c.txt -L "http://127.0.0.1:3080/?token=$TOKEN" -o /dev/null
curl -s -b /tmp/c.txt http://127.0.0.1:3080/ts/api/state      # 期望 200
curl -s -b /tmp/c.txt http://127.0.0.1:3080/ts/api/tools      # 期望 24 个 ts_* 工具
```

### 浏览器验证

标签栏（`conversation.view` 插槽）只在**有会话**时才渲染。起一个临时实例验证，不污染真实 profile：

```bash
DEEPSEEK_API_KEY=sk-dummy-local-check dsh web --port 3081 --no-open
```

用占位 key 建一条消息触发会话（模型调用必然报「API 密钥无效」，**不影响验证**——会话一旦建立，标签栏就会渲染），然后：

- 标签行应出现 `对话 | 轨迹 | 任务 | 想法`
- 「任务」页应出现 `今日 | 四象限 | 长期池` + 「新建任务」
- 浏览器控制台：`document.querySelector('style[data-plugin-css="dsh-plugin-tiny-schedule/styles.css"]')` 应存在（证明浏览器半边 `apply()` 跑过）
- 建一条任务 → 检查 `~/.dsh/storages/task_tracker.json` 落库 → 删掉它（清理测试数据）

---

## 6. 坑位速查表

| 症状 | 根因 | 处理 |
| --- | --- | --- |
| `tsc` OOM，源码没改 | 插件与 `dsh-storage-domain` 的 zod 版本不一致 | 把 zod 钉到宿主那个版本 |
| `Property 'slots' does not exist on type 'Context'` | Context 增强换包了 | 加新家的 peer 依赖 + type-only 导入 |
| `Property 'storageDomain' does not exist` | 同上，宿主半边也搬家了 | 查 `declare module '@deepseek-ai/cordis'` 在哪个包 |
| `incorrect peer dependency` 警告 | 旧 `bun.lock` 残留解析 | `rm -rf node_modules packages/*/node_modules bun.lock && bun install` |
| `spawn pnpm ENOENT` | pnpm 不在 PATH | `npm install -g pnpm` |
| 运行时原生模块报错 | npm 11 没跑安装脚本 | 加 `--allow-scripts=...` 重装 |
| 标签页偶尔不出现 | 客户端加载顺序没声明 | 补 `dsh.client.inject` |
| `installation rejected: incompatible` | peer 版本与 dsh 不匹配 | 正常升级 peer 依赖（别用 allow-version 绕过） |

---

## 7. 收尾

升级完成后同步更新这些地方，别让文档撒谎：

- `packages/dsh-plugin/package.json` — peer / dev / zod 版本
- `packages/dsh-plugin/README.md` — Compatibility 一节，写明两个关键 pin 的原因
- `docs/adr/0009-tiny-schedule-becomes-a-dsh-plugin.md` — dsh 版本耦合那条后果
- 本文（新增的坑位补进速查表）
