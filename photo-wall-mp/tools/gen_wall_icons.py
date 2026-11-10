"""生成墙页 dock 的两枚图标（对照原型 App.jsx 里的 inline SVG）。

- dice.png   骰子：圆角方框 + 三颗点（原型 viewBox 0 0 24 24, stroke 1.8）
- camera.png 相机：机身轮廓 + 镜头圆（stroke 1.7，纸色画在墨底快门上）

16 倍绘制后 LANCZOS 缩到 128px 做抗锯齿；透明底 PNG。
输出到 packages/ui-taro/src/static/img/（与照片同机制，/static/img/x.png 可引用）。
"""
import os
from PIL import Image, ImageDraw

S = 16          # 绘制倍数（viewBox 24 → 384px）
OUT = 128       # 输出尺寸
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, '..', 'packages', 'ui-taro', 'src', 'static', 'img') + os.sep
INK = (23, 23, 26, 255)      # 原型 --ink
PAPER = (250, 250, 248, 255)  # 原型 --paper


def canvas() -> Image.Image:
    return Image.new("RGBA", (24 * S, 24 * S), (0, 0, 0, 0))


def save(img: Image.Image, name: str) -> None:
    img.resize((OUT, OUT), Image.LANCZOS).save(BASE + name, optimize=True)
    print("wrote", BASE + name)


# ---- 骰子：rect rx=4 + 三个圆点 (8.5,8.5) (15.5,15.5) (12,12) r=1.2 ----
dice = canvas()
d = ImageDraw.Draw(dice)
d.rounded_rectangle(
    [3 * S, 3 * S, 21 * S, 21 * S],
    radius=4 * S,
    outline=INK,
    width=round(1.8 * S),
)
for cx, cy in ((8.5, 8.5), (15.5, 15.5), (12, 12)):
    r = 1.2 * S
    d.ellipse([cx * S - r, cy * S - r, cx * S + r, cy * S + r], fill=INK)
save(dice, "dice.png")

# ---- 相机：M3 8.5 h3.2 L8 6 h8 l1.8 2.5 H21 v10 H3 z + circle(12,13) r3.4 ----
cam = canvas()
d = ImageDraw.Draw(cam)
pts = [(3, 8.5), (6.2, 8.5), (8, 6), (16, 6), (17.8, 8.5), (21, 8.5),
       (21, 18.5), (3, 18.5), (3, 8.5)]
d.line([(x * S, y * S) for x, y in pts], fill=PAPER, width=round(1.7 * S),
       joint="curve")
r = 3.4 * S
cx, cy = 12 * S, 13 * S
d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=PAPER, width=round(1.7 * S))
save(cam, "camera.png")
