"""渲染城市筛选三个方案的效果对比图（PIL 直绘，2x 精度）。

单位：pt（390x844 手机屏），S=2 放大到物理像素。
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
S = 2
PW, PH = 390, 844          # 手机逻辑尺寸 pt
PX, PY = PW * S, PH * S    # 像素

# ---- 色板（与小程序 token 对齐）----
PAPER = (253, 253, 252, 255)
INK = (23, 23, 26, 255)
INK2 = (94, 94, 102, 255)
INK3 = (140, 140, 148, 255)
HAIR = (230, 230, 229, 255)          # hairline 叠在纸上的实色
ACCENT = (166, 61, 42, 255)
ON_INK_SUB = (161, 161, 160, 255)    # 墨底上的次要字
CANVAS_BG = (231, 230, 226, 255)

YH = "C:/Windows/Fonts/msyh.ttc"
YHB = "C:/Windows/Fonts/msyhbd.ttc"
MONO = "C:/Windows/Fonts/consola.ttf"
MONOB = "C:/Windows/Fonts/consolab.ttf"


def f(path, pt, index=0):
    return ImageFont.truetype(path, int(round(pt * S)), index=index)


def px(v):
    return int(round(v * S))


def tracked(d, xy, s, font, fill, tracking_pt, anchor="lm"):
    x, y = xy
    tr = px(tracking_pt)
    for ch in s:
        d.text((x, y), ch, font=font, fill=fill, anchor=anchor)
        x += d.textlength(ch, font=font) + tr
    return x


def new_layer(size=(PX, PY)):
    return Image.new("RGBA", size, (0, 0, 0, 0))


def rounded_mask(size, box, r):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle(box, radius=r, fill=255)
    return m


def clip(layer, mask):
    layer.putalpha(Image.composite(layer.getchannel("A"), Image.new("L", layer.size, 0), mask))
    return layer


def shadow(size, box, r, blur_pt, alpha):
    sh = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(box, radius=r, fill=(23, 23, 26, alpha))
    return sh.filter(ImageFilter.GaussianBlur(px(blur_pt)))


def phone_base(bg):
    base = Image.new("RGBA", (PX, PY), PAPER)
    base.paste(bg.resize((PX, PY), Image.LANCZOS), (0, 0))
    return base


def round_phone(im, r=30):
    mask = rounded_mask(im.size, [0, 0, PX - 1, PY - 1], px(r))
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    return out


# ================= A · 顶栏下拉菜单 =================
def panel_a(bg):
    base = phone_base(bg)
    card = (126, 98, 376, 98 + 322)
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle([px(card[0]), px(card[1]), px(card[2]), px(card[3])],
                        radius=px(16), fill=PAPER)

    x0, y0 = card[0] + 6, card[1] + 6
    x1 = card[2] - 6
    f_h = f(YH, 10)
    tracked(d, (px(x0 + 12), px(y0 + 14)), "按城市看墙 · 选完墙自己重排", f_h, INK3, 1.4)

    rows = [("全部", "12", True), ("成都", "3", False), ("乐山", "2", False),
            ("北京", "2", False), ("上海", "1", False), ("武汉", "1", False),
            ("长沙", "1", False), ("厦门", "1", False), ("未记", "1", False)]
    f_name, f_num = f(YH, 14), f(MONO, 11)
    y = y0 + 34
    for name, num, on in rows:
        ry0, ry1 = px(y), px(y + 42)
        if on:
            d.rounded_rectangle([px(x0), ry0, px(x1), ry1], radius=px(10), fill=INK)
            fill_name, fill_num = PAPER, ON_INK_SUB
        else:
            fill_name, fill_num = INK, INK3
        d.text((px(x0 + 12), (ry0 + ry1) // 2), name, font=f_name, fill=fill_name, anchor="lm")
        d.text((px(x1 - 12), (ry0 + ry1) // 2), num, font=f_num, fill=fill_num, anchor="rm")
        y += 42

    # 底部纸色渐隐
    fade_top = card[3] - 24
    for i in range(px(24)):
        a = int(255 * i / max(1, px(24) - 1))
        yy = px(fade_top) + i
        d.line([(px(card[0]), yy), (px(card[2]), yy)], fill=(253, 253, 252, a))

    layer = clip(layer, rounded_mask(layer.size, [px(card[0]), px(card[1]), px(card[2]), px(card[3])], px(16)))
    out = Image.alpha_composite(base, shadow((PX, PY), [px(card[0]), px(card[1]) + px(6), px(card[2]), px(card[3]) + px(8)], px(16), 14, 62))
    out = Image.alpha_composite(out, layer)
    # 边框
    bl = new_layer()
    ImageDraw.Draw(bl).rounded_rectangle([px(card[0]), px(card[1]), px(card[2]), px(card[3])],
                                         radius=px(16), outline=HAIR, width=px(0.5))
    out = Image.alpha_composite(out, bl)
    return out


# ================= B · 底部抽屉 =================
def panel_b(bg):
    base = phone_base(bg)
    dim = new_layer()
    ImageDraw.Draw(dim).rectangle([0, 0, PX, PY], fill=(23, 23, 26, 88))
    out = Image.alpha_composite(base, dim)

    cells = [("全部", "12", True), ("成都", "3", False), ("乐山", "2", False),
             ("北京", "2", False), ("上海", "1", False), ("武汉", "1", False),
             ("长沙", "1", False), ("厦门", "1", False), ("未记", "1", False)]
    cols, cell_h, gap = 2, 46, 8
    rows_n = (len(cells) + cols - 1) // cols
    grid_h = rows_n * cell_h + (rows_n - 1) * gap
    gm_max = 292
    sheet_h = 10 + 4 + 14 + (14 + 10) + min(grid_h, gm_max) + 26
    sy = PH - sheet_h

    layer = new_layer()
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle([0, px(sy), PX, px(PH) + px(24)], radius=px(22), fill=PAPER)
    # 把手
    d.rounded_rectangle([px(PW / 2 - 18), px(sy + 10), px(PW / 2 + 18), px(sy + 14)],
                        radius=px(2), fill=(220, 220, 214, 255))
    # 标题行
    tracked(d, (px(18), px(sy + 10 + 4 + 14 + 7)), "按城市看墙 · 选完墙自己重排", f(YH, 10), INK3, 1.4)

    # 网格
    cx0, cy0 = 14, sy + 10 + 4 + 14 + 24
    cell_w = (PW - 2 * 14 - gap * (cols - 1)) / cols
    f_name, f_num = f(YH, 14), f(MONO, 11)
    grid_layer = new_layer()
    gd = ImageDraw.Draw(grid_layer)
    for i, (name, num, on) in enumerate(cells):
        r_, c_ = divmod(i, cols)
        x = cx0 + c_ * (cell_w + gap)
        y = cy0 + r_ * (cell_h + gap)
        box = [px(x), px(y), px(x + cell_w), px(y + cell_h)]
        if on:
            gd.rounded_rectangle(box, radius=px(12), fill=INK)
            fill_name, fill_num = PAPER, ON_INK_SUB
        else:
            gd.rounded_rectangle(box, radius=px(12), fill=PAPER, outline=HAIR, width=px(0.5))
            fill_name, fill_num = INK2, INK3
        gd.text((px(x + 14), (box[1] + box[3]) // 2), name, font=f_name, fill=fill_name, anchor="lm")
        gd.text((px(x + cell_w - 14), (box[1] + box[3]) // 2), num, font=f_num, fill=fill_num, anchor="rm")

    # 网格区裁剪 + 底部渐隐
    gm_bottom = cy0 + min(grid_h, gm_max)
    grid_layer = clip(grid_layer, rounded_mask(grid_layer.size,
                                               [px(14), px(cy0), px(PW - 14), px(gm_bottom)], 1))
    layer = Image.alpha_composite(layer, grid_layer)
    if grid_h > gm_max:  # 只有溢出时才画渐隐（放得下就别遮最后一行）
        d2 = ImageDraw.Draw(layer)
        for i in range(px(26)):
            a = int(255 * i / max(1, px(26) - 1))
            yy = px(gm_bottom - 26) + i
            d2.line([(px(14), yy), (px(PW - 14), yy)], fill=(253, 253, 252, a))

    out = Image.alpha_composite(out, shadow((PX, PY), [0, px(sy) - px(4), PX, px(PH)], px(22), 16, 50))
    out = Image.alpha_composite(out, layer)
    return out


# ================= C · 原生 Picker =================
def panel_c(bg):
    base = phone_base(bg)
    dim = new_layer()
    ImageDraw.Draw(dim).rectangle([0, 0, PX, PY], fill=(0, 0, 0, 102))
    out = Image.alpha_composite(base, dim)

    wheel_h, row_h, bar_h, pad_b = 200, 40, 46, 22
    pick_h = bar_h + wheel_h + pad_b
    py0 = PH - pick_h

    layer = new_layer()
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle([0, px(py0), PX, px(PH) + px(24)], radius=px(12), fill=(247, 247, 248, 255))
    # bar
    d.line([(0, px(py0 + bar_h)), (PX, px(py0 + bar_h))], fill=(236, 236, 236, 255), width=px(0.5))
    f_cancel = f(YH, 15)
    d.text((px(16), px(py0 + bar_h / 2)), "取消", font=f_cancel, fill=(0, 122, 255, 255), anchor="lm")
    d.text((px(PW - 16), px(py0 + bar_h / 2)), "完成", font=f_cancel, fill=(0, 122, 255, 255), anchor="rm")
    f_title = f(YHB, 13)
    d.text((px(PW / 2), px(py0 + bar_h / 2)), "选择城市", font=f_title, fill=(28, 28, 30, 255), anchor="mm")
    # 选中带（实色预混，PIL 的 alpha fill 是像素替换不是混合）
    sel_i = 2
    wy = py0 + bar_h
    d.rectangle([0, px(wy + sel_i * row_h), PX, px(wy + (sel_i + 1) * row_h)], fill=(238, 238, 239, 255))
    d.line([(0, px(wy + sel_i * row_h)), (PX, px(wy + sel_i * row_h))], fill=(229, 229, 229, 255), width=px(0.5))
    d.line([(0, px(wy + (sel_i + 1) * row_h)), (PX, px(wy + (sel_i + 1) * row_h))], fill=(229, 229, 229, 255), width=px(0.5))
    # 滚轮文字
    ws = ["全部 12", "成都 3", "乐山 2", "北京 2", "上海 1"]
    for i, s in enumerate(ws):
        cy = py0 + bar_h + i * row_h + row_h / 2
        if i == sel_i:
            d.text((px(PW / 2), px(cy)), s, font=f(YH, 21), fill=(28, 28, 30, 255), anchor="mm")
        else:
            d.text((px(PW / 2), px(cy)), s, font=f(YH, 20), fill=(188, 188, 188, 255), anchor="mm")

    out = Image.alpha_composite(out, shadow((PX, PY), [0, px(py0) - px(2), PX, px(PH)], px(12), 16, 60))
    out = Image.alpha_composite(out, layer)
    return out


def wrap(d, s, font, max_w):
    lines, cur = [], ""
    for ch in s:
        if d.textlength(cur + ch, font=font) <= max_w:
            cur += ch
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


def main():
    bg = Image.open(os.path.join(HERE, "_mock_bg.jpg")).convert("RGB")

    panels = [panel_a(bg), panel_b(bg), panel_c(bg)]
    panels = [round_phone(p) for p in panels]

    caps = [
        ("A · 顶栏下拉菜单", "纸色卡片锚在「城市」下，一行一城竖滑；只盖右上一块，墙其余全可见"),
        ("B · 底部抽屉（两列网格）", "容量最大，一屏二十多项；打开时盖下半屏，点一下就关"),
        ("C · 原生 Picker（系统滚轮）", "页面零占屏、实现量最小、最「微信」；代价是离纸色风格最远"),
    ]

    pad, gap_pt = 30, 30
    title_h, cap_line = 20, 18
    canvas_w = pad * 3 + PW * 3 + gap_pt * 2
    cap_d = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    cap_text_w = PW - 2
    wrapped = [wrap(cap_d, c[1], f(YH, 11.5), px(cap_text_w)) for c in caps]
    canvas_h = 26 + 22 + 18 + PH + 12 + cap_line * (1 + max(len(w) for w in wrapped)) + 28

    canvas = Image.new("RGBA", (px(canvas_w), px(canvas_h)), CANVAS_BG)
    d = ImageDraw.Draw(canvas)
    d.text((px(pad), px(26 + 10)), "城市筛选 · 三个优化方案", font=f(YHB, 15), fill=INK, anchor="lm")
    d.text((px(pad + 196), px(26 + 12)), "同一面墙上的效果对比 · 全部 12 张", font=f(YH, 11.5), fill=INK3, anchor="lm")

    for i, (p, (cap_a, _), lines) in enumerate(zip(panels, caps, wrapped)):
        x = pad + i * (PW + gap_pt)
        y = 64
        canvas.paste(p, (px(x), px(y)), p)
        d.text((px(x), px(y + PH + 14)), cap_a, font=f(YHB, 13.5), fill=INK, anchor="lm")
        for j, ln in enumerate(lines):
            d.text((px(x), px(y + PH + 14 + 18 * (j + 1))), ln, font=f(YH, 11.5), fill=INK3, anchor="lm")

    out = canvas.convert("RGB")
    out.save(os.path.join(HERE, "_mock_options.png"))
    big = out.resize((1600, int(out.height * 1600 / out.width)), Image.LANCZOS)
    big.save(os.path.join(HERE, "_mock_options_1600.png"))
    print("ok", out.size, big.size)


main()
