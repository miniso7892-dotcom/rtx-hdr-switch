"""生成扩展图标：深色圆角底 + 太阳；48/128 再加「HDR」字样。

用法：python tools/make_icons.py   （输出到 icons/icon16/32/48/128.png）
依赖：Pillow
"""
from pathlib import Path
import math

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
SIZES = (16, 32, 48, 128)
SS = 8  # 超采样倍数，缩小时抗锯齿

BG_TOP = (36, 48, 78)
BG_BOTTOM = (12, 17, 32)
SUN_CORE = (255, 246, 214)
SUN_MID = (255, 196, 46)
SUN_EDGE = (255, 143, 0)
RAY = (255, 186, 40)
TEXT = (255, 255, 255)

FONT_CANDIDATES = (
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "DejaVuSans-Bold.ttf",
)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def load_font(px):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, px)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=px)  # Pillow >= 10.1
    except TypeError:
        return ImageFont.load_default()


def background(n):
    img = Image.new("RGBA", (n, n))
    draw = ImageDraw.Draw(img)
    for y in range(n):
        draw.line([(0, y), (n, y)], fill=lerp(BG_TOP, BG_BOTTOM, y / (n - 1)) + (255,))
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=round(n * 0.22), fill=255)
    img.putalpha(mask)
    return img


def draw_sun(img, cx, cy, r, ray_in, ray_out, ray_w, rays=8):
    draw = ImageDraw.Draw(img)
    for i in range(rays):
        a = math.tau * i / rays - math.pi / 2
        x0, y0 = cx + math.cos(a) * ray_in, cy + math.sin(a) * ray_in
        x1, y1 = cx + math.cos(a) * ray_out, cy + math.sin(a) * ray_out
        draw.line([(x0, y0), (x1, y1)], fill=RAY + (255,), width=round(ray_w))
        for x, y in ((x0, y0), (x1, y1)):  # 圆头
            h = ray_w / 2
            draw.ellipse([x - h, y - h, x + h, y + h], fill=RAY + (255,))
    steps = max(24, round(r))
    for i in range(steps, 0, -1):  # 由外到内画同心圆，做径向渐变
        t = i / steps
        color = lerp(SUN_MID, SUN_EDGE, (t - 0.55) / 0.45) if t > 0.55 else lerp(SUN_CORE, SUN_MID, t / 0.55)
        rr = r * t
        draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=color + (255,))


def make(size):
    n = size * SS
    img = background(n)
    if size >= 48:
        cx, cy = n / 2, n * 0.33
        draw_sun(img, cx, cy, n * 0.13, n * 0.18, n * 0.25, n * 0.045)
        font = load_font(round(n * 0.27))
        draw = ImageDraw.Draw(img)
        box = draw.textbbox((0, 0), "HDR", font=font)
        tw, th = box[2] - box[0], box[3] - box[1]
        x = (n - tw) / 2 - box[0]
        y = n * 0.885 - th - box[1]
        draw.text((x, y), "HDR", font=font, fill=TEXT + (255,))
    else:
        cx = cy = n / 2
        if size <= 16:
            draw_sun(img, cx, cy, n * 0.21, n * 0.30, n * 0.42, n * 0.10)
        else:
            draw_sun(img, cx, cy, n * 0.20, n * 0.285, n * 0.40, n * 0.075)
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for s in SIZES:
        path = OUT / f"icon{s}.png"
        make(s).save(path, optimize=True)
        print(f"wrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
