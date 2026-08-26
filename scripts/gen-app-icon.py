#!/usr/bin/env python3
"""
gen-app-icon.py — 从 source jpeg 生成 app icon 全套资源

输入:packages/app/assets/source/<source>.jpeg  (圆角矩形内有人物的 jpeg)
输出:
  packages/app/assets/build/icon.png      1024×1024 RGBA,圆角矩形外透明
  packages/app/assets/build/icon.icns     macOS bundle 图标
  packages/app/assets/renderer/favicon-{16,32}.png  renderer 静态资源

几何参数(从 source jpeg 实测拟合):
  圆角矩形 bounds = (84, 83, 939, 939)  in 1024×1024
  corner radius   = 172

前置依赖:PIL + numpy,系统工具 sips / iconutil (macOS)
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS = REPO_ROOT / "packages" / "app" / "assets"
SRC = ASSETS / "source" / "tiny_schedule_app_iconV2.jpeg"
BUILD = ASSETS / "build"
RENDERER = ASSETS / "renderer"

OUTER = (84, 83, 939, 939)
CORNER_R = 172
ICON_SIZE = 1024


def strip_background(src: Path, dst: Path) -> None:
    """用圆角矩形几何 mask 把 source jpeg 外圈设为透明,内部像素原样保留。"""
    img_rgb = np.array(Image.open(src).convert("RGB"))
    h, w = img_rgb.shape[:2]

    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle(OUTER, radius=CORNER_R, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=0.6))

    alpha = np.array(mask).astype(np.float32) / 255.0
    out = np.dstack([img_rgb, (alpha * 255).astype(np.uint8)])
    dst.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(out).save(dst)
    print(f"  ✓ {dst.relative_to(REPO_ROOT)}")


def make_iconset(
    png: Path, iconset_dir: Path, sizes=(16, 32, 64, 128, 256, 512)
) -> None:
    iconset_dir.mkdir(parents=True, exist_ok=True)
    for size in sizes:
        subprocess.run(
            [
                "sips",
                "-z",
                str(size),
                str(size),
                str(png),
                "--out",
                str(iconset_dir / f"icon_{size}x{size}.png"),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        subprocess.run(
            [
                "sips",
                "-z",
                str(size * 2),
                str(size * 2),
                str(png),
                "--out",
                str(iconset_dir / f"icon_{size}x{size}@2x.png"),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    # 1024px 是 512@2x 的另一种命名,electron-builder 期望的格式
    subprocess.run(
        [
            "sips",
            "-z",
            str(ICON_SIZE),
            str(ICON_SIZE),
            str(png),
            "--out",
            str(iconset_dir / "icon_512x512@2x.png"),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def make_icns(png: Path, icns: Path) -> None:
    iconset = png.parent / "_iconset_tmp.iconset"
    make_iconset(png, iconset)
    subprocess.run(
        ["iconutil", "-c", "icns", str(iconset), "-o", str(icns)],
        check=True,
    )
    shutil.rmtree(iconset)
    print(f"  ✓ {icns.relative_to(REPO_ROOT)}")


def make_favicon(png: Path, dst: Path, size: int) -> None:
    subprocess.run(
        ["sips", "-z", str(size), str(size), str(png), "--out", str(dst)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print(f"  ✓ {dst.relative_to(REPO_ROOT)}")


def main() -> int:
    if not SRC.exists():
        print(f"error: source not found: {SRC}", file=sys.stderr)
        return 1
    if sys.platform != "darwin":
        print(
            "warning: sips/iconutil are macOS-only; PNG 仍可生成,但 icns/favicon 会失败",
            file=sys.stderr,
        )

    png = BUILD / "icon.png"
    icns = BUILD / "icon.icns"

    print("gen-app-icon: regenerating from", SRC.relative_to(REPO_ROOT))
    strip_background(SRC, png)
    make_icns(png, icns)
    make_favicon(png, RENDERER / "favicon-32.png", 32)
    make_favicon(png, RENDERER / "favicon-16.png", 16)
    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
