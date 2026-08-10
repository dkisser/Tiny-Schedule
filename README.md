# Tiny-Schedule

本地优先的任务管理 + AI 分析桌面应用（Electron），可导入 Super Productivity 备份。

## 开发

要求：Node.js >= 20、Bun >= 1.2

```bash
bun install
bun run dev        # 启动 Electron 开发环境
bun test           # 运行全部测试
bun run lint       # Biome 检查
bun run typecheck  # TypeScript 项目引用构建
```

## 构建

```bash
bun run build      # 产出 packages/app/out
```

## 发布（macOS GitHub Releases）

通过 [electron-builder](https://www.electron.build/) 打包 macOS `.dmg`，由 GitHub Actions 在推送 `v*` tag 时自动发布到 [Releases](https://github.com/dkisser/Tiny-Schedule/releases)。

**打 tag 触发**：

```bash
git tag v0.1.0
git push origin v0.1.0
```

Actions 中的 `release.yml` 会在 `macos-latest` runner 上：跑 lint/typecheck/test → 用 electron-vite 编译 → 用 electron-builder 产出 `Tiny Schedule-<version>-arm64.dmg` 与 `Tiny Schedule-<version>-x64.dmg` → 自动创建同名 GitHub Release 并上传。

**首次安装（个人未签名）**：

未做 Apple Developer ID 签名与公证，macOS Gatekeeper 会拦截。可任选其一：

- **右键打开（推荐）**：挂载 `.dmg` → 把 `Tiny Schedule.app` 拖入 Applications → 在 Applications 中 **右键** `Tiny Schedule.app` → **打开** → 在弹窗中再次确认"打开"。后续双击即可正常启动。
- **清除隔离属性（更彻底）**：若右键仍被拦截，先在 Applications 退出 app，然后执行：

  ```bash
  sudo xattr -rd com.apple.quarantine "/Applications/Tiny Schedule.app"
  ```

  之后双击即可正常启动。

**本地冒烟打包**：

```bash
bun install
bun run build
bun run release:dir   # 仅展开 .app 到 packages/app/release/
# 或
bun run release       # 产出 .dmg 到 packages/app/release/，不发布
```

> `release` 脚本默认 `--publish never`，仅做本地验证；上传到 GitHub Releases 的逻辑只在 CI 中以 `--publish always` 执行。

## 功能

- 任务管理：项目 / 标签 / 今日 / Upcoming / 子任务 / 计时
- 导入 Super Productivity 备份 JSON（整库覆盖，自动备份）
- Markdown 导出：项目任务清单、工作日志
- AI 分析：多 OpenAI 兼容 Provider（设置页配置 API key），日报/周报
- 设置：用户信息、Light/Dark/跟随系统主题、AI Provider 与自定义 Prompt
