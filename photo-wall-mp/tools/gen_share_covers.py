#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成分享封面（5:4 转发卡片 + 1:1 朋友圈卡片）。

设计口径与小程序一致：
· 纸底 #FAFAF8，砖红点 #A63D2A（与顶栏品牌点同色，不是 tomato-9）
· 品牌名无衬线（和自绘顶栏一致），副标题等宽小字
· 照片是唯一彩色，三张并排、4px 级缝
· 不写任何会过期的数字（张数/城市数）—— 分享图是长期资产

用法（仓库根目录）：
  python tools/gen_share_covers.py
产出：
  packages/ui-taro/src/static/img/share-cover.jpg      800×640（5:4）
  packages/ui-taro/src/static/img/share-timeline.jpg   800×800（1:1）
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / 'packages' / 'ui-taro' / 'src' / 'static' / 'img'

PAPER = (250, 250, 248)
INK = (23, 23, 26)
INK2 = (94, 94, 102)
BRICK = (166, 61, 42)

SANS = 'C:/Windows/Fonts/msyh.ttc'
SANS_BOLD = 'C:/Windows/Fonts/msyhbd.ttc'

PHOTOS = ['kaoya.jpg', 'tiantianmian.jpg', 'danhonggao.jpg']

MARGIN = 56  # 1000 宽上的页边距（≈ 小程序 32rpx @390）


def crop_square(img: Image.Image, w: int, h: int) -> Image.Image:
    """按 cover 语义裁切：先按目标比例放大，再居中裁。"""
    target = w / h
    ratio = img.width / img.height
    if ratio > target:
        nw = int(img.height * target)
        img = img.crop(((img.width - nw) // 2, 0, (img.width + nw) // 2, img.height))
    else:
        nh = int(img.width / target)
        img = img.crop((0, (img.height - nh) // 2, img.width, (img.height + nh) // 2))
    return img.resize((w, h), Image.LANCZOS)


def build(width: int, height: int, out: Path) -> None:
    canvas = Image.new('RGB', (width, height), PAPER)
    d = ImageDraw.Draw(canvas)

    # 品牌行：红点 + 名字；副标题在下面一行
    dot_r = 9
    dot_cx, dot_cy = MARGIN + dot_r, MARGIN + 18
    d.ellipse(
        [dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r],
        fill=BRICK,
    )
    brand = ImageFont.truetype(SANS_BOLD, 46)
    d.text((dot_cx + dot_r + 18, dot_cy - 26), 'X师傅美食记', font=brand, fill=INK)

    sub = ImageFont.truetype(SANS, 22)
    d.text((MARGIN, dot_cy + 34), '一面贴满吃的墙', font=sub, fill=INK2)

    # 照片条：三张并排，缝 6，底部与画布留出页边距
    gap = 6
    top = MARGIN + 96
    bottom = height - MARGIN
    strip_h = bottom - top
    cell_w = (width - 2 * MARGIN - 2 * gap) // 3
    for i, name in enumerate(PHOTOS):
        src = Image.open(IMG / name).convert('RGB')
        cell = crop_square(src, cell_w, strip_h)
        x = MARGIN + i * (cell_w + gap)
        canvas.paste(cell, (x, top))

    canvas.save(out, 'JPEG', quality=80, optimize=True, progressive=True)
    print(f'wrote {out} {canvas.size} {out.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    build(800, 640, IMG / 'share-cover.jpg')
    build(800, 800, IMG / 'share-timeline.jpg')
