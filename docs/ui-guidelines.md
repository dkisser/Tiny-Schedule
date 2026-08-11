# UI 组件规范

本文档约定 renderer 层（`packages/app/src/renderer`）的按钮、图标与间距用法。所有新代码必须遵守；改动旧代码时顺手对齐。

## 按钮

一律使用 `@/components/ui/button` 的 `Button`，禁止原生 `<button>` + 手写样式。

| 场景 | variant | size |
| --- | --- | --- |
| 表单/对话框主操作 | `default` / `outline` / `destructive` | `default` |
| 紧凑操作（列表工具区、辅助操作） | `outline` / `ghost` | `sm` |
| 工具栏图标按钮（TimerBar 等） | `ghost` | `icon-sm` |
| 行内/密集区图标按钮（侧栏行操作、卡片操作、输入框内嵌） | `ghost` | `icon-xs` |
| 极紧凑的文字辅助操作 | `ghost` | `xs` |

例外（允许保留原生元素，但样式按下文图标/间距约定）：

- 整行导航项（如侧栏 `NavItem`）、chip 等非按钮语义的容器。
- chip 内部的移除按钮：无 padding 的原生 `<button>` + `h-3 w-3` 图标。
- 任务卡的圆形完成勾选（`TaskCard`）：圆圈画在 button 上（`size-4 rounded-full border` + `flex items-center justify-center`），Check 图标 `h-3 w-3` 居中，不要把 border/padding 画在 SVG 上。

## 图标

全部使用 `lucide-react`，禁止手写 SVG。

- `Button` 内部：不写 `className`，由组件按 size 自动定尺寸（default/sm/icon-sm 为 16px，xs/icon-xs 为 12px）；图标与文字的间距由 Button 的 `gap` 提供，不要再加 `mr-1` 等 margin。
- 非 `Button` 场景只允许三档：
  - `h-3 w-3`（12px）：chip、徽章、状态标签内。
  - `h-3.5 w-3.5`（14px）：侧栏分组头等紧凑辅助区。
  - `h-4 w-4`（16px）：默认，导航行、正文区域。

## 间距

- 工具栏/操作区按钮组：`gap-1`。
- 行内 hover 显现的操作组：`gap-0.5`。
- 表单、对话框底部按钮：`gap-2`（DialogFooter 默认）。
