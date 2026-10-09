#!/usr/bin/env bash
# 构建 macOS EventKit Swift CLI helper(event-helper)。
# - macOS + swift 可用:swift build + 复制到 ../bin/event-helper
# - 其他平台或 swift 缺失:warn,exit 0(不阻塞 dev/CI)
#
# 强制重建:REBUILD_EVENT_HELPER=1 ./scripts/build-event-helper.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
SWIFT_PKG_DIR="$PKG_DIR/event-helper"
BIN_SRC="$SWIFT_PKG_DIR/.build/release/event-helper"
BIN_DST="$PKG_DIR/bin/event-helper"

# 非 macOS 跳过
if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "build-event-helper: skip (non-macOS)" >&2
    exit 0
fi

# swift 工具链缺失跳过(给清晰的提示而非失败)
if ! command -v swift >/dev/null 2>&1; then
    echo "build-event-helper: skip ('swift' not found; install Xcode Command Line Tools)" >&2
    exit 0
fi

# 二进制比源码新 → 跳过(除非 REBUILD_EVENT_HELPER=1)
if [[ "${REBUILD_EVENT_HELPER:-0}" != "1" && -x "$BIN_DST" ]]; then
    if [[ "$BIN_DST" -nt "$SWIFT_PKG_DIR/Package.swift" ]]; then
        newest_src=$(find "$SWIFT_PKG_DIR/Sources" "$SWIFT_PKG_DIR/Package.swift" -type f -name "*.swift" -o -name "Package.swift" 2>/dev/null | xargs stat -f "%m %N" 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
        if [[ -n "$newest_src" && "$BIN_DST" -nt "$newest_src" ]]; then
            echo "build-event-helper: skip (binary up-to-date; REBUILD_EVENT_HELPER=1 to force)" >&2
            exit 0
        fi
    fi
fi

echo "build-event-helper: building..." >&2
(cd "$SWIFT_PKG_DIR" && swift build -c release)

mkdir -p "$(dirname "$BIN_DST")"
cp "$BIN_SRC" "$BIN_DST"
chmod +x "$BIN_DST"
echo "build-event-helper: installed $BIN_DST" >&2