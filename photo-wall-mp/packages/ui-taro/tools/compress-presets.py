#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
预置配图压缩：在不降低可见画质的前提下把包体里的静态图压小。

背景：`dist/static/` 一度占小程序主包 70%（1,007,925 B / 1,440,066 B）。
这些图是"没有用户照片时按菜名哈希兜底"的预置图（core/src/records.ts 的
PHOTO_MAP），在墙上的实际渲染尺寸最大是 3 列 span = 492 物理像素
（@2x 屏；WALL_W=686rpx，单列 164rpx）。

压缩策略（刻意保守，不做有损缩尺寸）：
  · **保持原尺寸** 600px 宽 —— 缩到 492 会在大图 hero 位置看到发虚，
    而 600 已经在 1.22x 的余量上，是"够用且不浪费"的平衡点；
  · 重新编码为 **progressive JPEG + optimize + 4:4:4→4:2:0**：
    progressive 对首屏友好（分块渐进显示），4:2:0 在照片类内容上
    几乎看不出差别但能省 20~35%；
  · quality 从默认（这些图当初多半是 q90+）降到 **82**：
    美食照片 q82 与 q90 的肉眼差异极小，体积差 30%+；
  · 剥离 EXIF/ICC（包内配图不需要，也能省几百字节）。

用法：
  python tools/compress-presets.py --dry-run    # 只看能省多少
  python tools/compress-presets.py              # 实际写入
  python tools/compress-presets.py --quality 85 # 换质量

⚠ 只处理 PHOTO_MAP 里引用的 12 张预置图 + 分享封面；用户照片不在此列
（它们走后端上传，不占包体）。
"""
from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow：pip install Pillow")

# 仓库内路径（脚本放在 packages/ui-taro/tools/ 下）
HERE = Path(__file__).resolve().parent
IMG_DIR = HERE.parent / "src" / "static" / "img"

# PHOTO_MAP 里的 12 张 + 分享封面（与 core/src/records.ts 保持一致）
PRESETS = [
    "tiantianmian.jpg", "bingfen.jpg", "qiaojiaoniurou.jpg", "boboboji.jpg",
    "kaoya.jpg", "fanqieniunan.jpg", "danhonggao.jpg", "shengjianbao.jpg",
    "douzhier.jpg", "reganmian.jpg", "tangyoubaba.jpg", "shachamian.jpg",
]
COVERS = ["share-cover.jpg", "share-timeline.jpg"]

# 图标是 PNG（小、带透明），不参与 JPEG 重编码
SKIP = {"dice.png", "camera.png"}


def human(n: int) -> str:
    return f"{n / 1024:.1f} KB" if n >= 1024 else f"{n} B"


def encode(img: Image.Image, quality: int) -> bytes:
    buf = io.BytesIO()
    img.save(
        buf,
        format="JPEG",
        quality=quality,
        optimize=True,
        progressive=True,
        subsampling="4:2:0",
    )
    return buf.getvalue()


def main() -> int:
    ap = argparse.ArgumentParser(description="压缩预置配图")
    ap.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    ap.add_argument("--quality", type=int, default=82, help="JPEG 质量（默认 82）")
    args = ap.parse_args()

    files = PRESETS + COVERS
    total_before = 0
    total_after = 0
    changed = 0

    print(f"{'文件':<24} {'原大小':>10} {'压缩后':>10} {'节省':>8}  尺寸")
    print("-" * 72)
    for name in files:
        path = IMG_DIR / name
        if not path.exists():
            print(f"{name:<24} {'(缺失)':>10}")
            continue
        before = path.stat().st_size
        total_before += before

        with Image.open(path) as im:
            im.load()
            size = im.size
            # 统一转 RGB（丢掉 EXIF/ICC；progressive 需要 RGB）
            rgb = im.convert("RGB") if im.mode != "RGB" else im
            data = encode(rgb, args.quality)

        # 只有当确实变小才替换（避免反向膨胀）
        use = data if len(data) < before else None
        after = len(use) if use else before
        total_after += after
        saved = before - after
        pct = (saved / before * 100) if before else 0
        flag = "" if use else "  (已是最优，跳过)"
        print(
            f"{name:<24} {human(before):>10} {human(after):>10} "
            f"{human(saved):>8}  {size[0]}x{size[1]}{flag}"
        )

        if use and not args.dry_run:
            path.write_bytes(use)
            changed += 1

    print("-" * 72)
    saved_all = total_before - total_after
    pct_all = (saved_all / total_before * 100) if total_before else 0
    print(
        f"{'合计':<24} {human(total_before):>10} {human(total_after):>10} "
        f"{human(saved_all):>8}  ({pct_all:.1f}%)"
    )
    if args.dry_run:
        print("\n[dry-run] 未写入任何文件。去掉 --dry-run 才会实际替换。")
    else:
        print(f"\n已替换 {changed} 个文件。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
