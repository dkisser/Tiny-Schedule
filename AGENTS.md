## UI 规范

按钮、图标与间距的统一约定见 docs/ui-guidelines.md。修改 renderer 层 UI 代码前请先阅读；按钮一律用 `@/components/ui/button` 的 `Button`，图标一律用 lucide-react。

## dsh 插件

`packages/dsh-plugin` 跟随 dsh 版本走。升级 dsh 版本前先读 docs/dsh-version-upgrade.md——版本闸门、zod 版本钉死、Context 增强搬家这几类坑都在里面，漏掉任何一条都会以 OOM 或类型报错的形式出现。
