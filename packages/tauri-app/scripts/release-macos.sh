#!/usr/bin/env bash
# 打出两个架构的 macOS .dmg：一个 arm64，一个 x64。
#
# 为什么是两次调用而不是一条命令带两个 --target：
# tauri CLI 的 --target 只接受单个值（`--target <TARGET>` 不允许重复），
# 所以双架构必须串行跑两次 cargo 构建。串行而非并行的理由是两次共用同一个
# target 目录，并行 cargo 会互相抢锁。
#
# 第二次调用复用第一次已经建好的 beforeBuildCommand 产物（../dist），但 Tauri
# 每次都会重跑一遍 beforeBuildCommand——这是渲染层打包十几秒的代价，换来的是
# 不去猜测缓存状态。
#
# 体积门禁不在这里做：release.yml 的 "Enforce size budget" 步骤是唯一权威，
# 本地跑这份脚本时不因为体积失败。
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for target in aarch64-apple-darwin x86_64-apple-darwin; do
  echo "release-macos: building $target" >&2
  tauri build --target "$target"
done

echo "release-macos: done" >&2
ls -lh src-tauri/target/*/release/bundle/dmg/*.dmg >&2