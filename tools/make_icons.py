"""生成扩展图标（方案 C · 高反差信号）：黑色圆角底板上一块白色「屏幕」，左半实心，
中间一道主题色分隔条。

用法：
  python tools/make_icons.py                        # 默认主题色 #A98BFF，写入 icons/icon16/32/48/128.png
  python tools/make_icons.py --accent "#4FC3F7"     # 换主题色：#RGB 或 #RRGGBB（# 前后要加引号，也可以不写 #）
  python tools/make_icons.py --accent 4FC3F7 --out some/dir
依赖：Pillow（只用来写 PNG）

几何定义在 128×128 的 viewBox 里，16/32/48 px 各有一套微调过的版本。运行时换色用的
icon-draw.js 画的是同一套几何，改这里时两边要一起改。

渲染方式：每个形状按像素精确面积算覆盖率（圆角处 16×16 超采样），再按 source-over
依次叠加（不用 LANCZOS 缩小，避免边缘振铃）。图层顺序与 icon-draw.js 相同，Chrome 的
fillRect 也是按精确面积抗锯齿，所以同一主题色下两边的结果逐像素一致，只有底板圆角上的
几个像素因 Chrome 的弧线抗锯齿略有出入（tools/icon-draw-test.html 会检查这一点）。
"""
from __future__ import annotations

import argparse
import math
import re
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SIZES = (16, 32, 48, 128)
DEFAULT_ACCENT = "#A98BFF"  # 薰衣紫，和 lib.js 的 DEFAULT_ACCENT 一致

VIEW = 128     # 几何坐标所在 viewBox 的边长
CORNER = 14    # 底板圆角半径（viewBox 单位）
BG = (0x0A, 0x0A, 0x0A)    # 底板
RING = (0x3A, 0x3A, 0x3A)  # 48 px 及以上的外圈描边，深色工具栏上也能分出轮廓
FG = (0xFA, 0xFA, 0xFA)    # 屏幕

# screen=[x, y, w, h] 是屏幕外框（描边居中，宽 stroke），fill 是实心的左半，bar 是主题色分隔条
BASE = {"stroke": 6, "screen": (21, 33, 86, 62), "fill": (18, 30, 46, 68), "bar": (60, 18, 9, 92)}
VARIANTS = {
    16: {"stroke": 14, "screen": (20, 32, 88, 64), "fill": (13, 25, 51, 78), "bar": (56, 10, 17, 108)},
    32: {"stroke": 10, "screen": (21, 33, 86, 62), "fill": (16, 28, 48, 72), "bar": (58, 14, 13, 100)},
    48: {**BASE, "bar": (59, 16, 11, 96)},
}
SUPERSAMPLE = 16  # 圆角处每个像素按 16×16 个采样点算覆盖率


def parse_accent(text: str) -> tuple[int, int, int]:
    m = re.fullmatch(r"#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", text.strip())
    if not m:
        raise argparse.ArgumentTypeError(f"accent must be #RGB or #RRGGBB, got {text!r}")
    h = m.group(1)
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def ring_width(size: int) -> int:
    """外圈描边宽度（px）：48 px 时 1 px，128 px 时 3 px；32 px 及以下不加。与 icon-draw.js 相同。"""
    return max(1, math.floor(size * 3 / VIEW + 0.5)) if size >= 48 else 0


def box(x, y, w, h, k):
    """viewBox 里的 [x, y, w, h] → 像素坐标 (x0, y0, x1, y1)。"""
    return (x * k, y * k, (x + w) * k, (y + h) * k)


def rect_cov(r, px, py):
    """像素 [px, px+1)×[py, py+1) 被矩形 r 盖住的精确面积。"""
    w = min(px + 1, r[2]) - max(px, r[0])
    h = min(py + 1, r[3]) - max(py, r[1])
    return w * h if w > 0 and h > 0 else 0.0


def rrect_cov(r, rad, px, py):
    """圆角矩形的覆盖率：不碰圆角的像素按矩形精确算，碰到圆角的超采样。"""
    x0, y0, x1, y1 = r
    corner_x = px < x0 + rad or px + 1 > x1 - rad
    corner_y = py < y0 + rad or py + 1 > y1 - rad
    if rad <= 0 or not (corner_x and corner_y):
        return rect_cov(r, px, py)
    n = SUPERSAMPLE
    hit = 0
    for j in range(n):
        y = py + (j + 0.5) / n
        if not y0 <= y < y1:
            continue
        dy = y - min(max(y, y0 + rad), y1 - rad)
        for i in range(n):
            x = px + (i + 0.5) / n
            if x0 <= x < x1:
                dx = x - min(max(x, x0 + rad), x1 - rad)
                if dx * dx + dy * dy <= rad * rad:
                    hit += 1
    return hit / (n * n)


def render(size: int, accent: tuple[int, int, int]) -> Image.Image:
    g = VARIANTS.get(size, BASE)
    k = size / VIEW
    sw = g["stroke"]
    sx, sy, w, h = g["screen"]
    fill_right = g["fill"][0] + g["fill"][2]
    radius = CORNER * k
    ring = ring_width(size)
    plate = (0, 0, size, size)
    plate_in = (ring, ring, size - ring, size - ring)
    # 屏幕：先按描边外沿铺满白色，再用底色把「描边内沿里、实心左半以右」的部分挖回来。
    # 实心左半的左/上/下边正好是描边外沿，分开画会在这些边上叠两遍抗锯齿；挖空区与外沿不共用像素，
    # 所以这样叠出来就是「描边框 ∪ 左半」的精确覆盖率。图层顺序与 icon-draw.js 相同。
    outer = box(sx - sw / 2, sy - sw / 2, w + sw, h + sw, k)
    hole_x0 = max(sx + sw / 2, fill_right)
    hole = box(hole_x0, sy + sw / 2, sx + w - sw / 2 - hole_x0, h - sw, k)
    bar = box(*g["bar"], k)

    def q(v):
        return min(255, max(0, math.floor(v * 255 + 0.5)))

    out = bytearray(size * size * 4)
    for py in range(size):
        for px in range(size):
            layers = (
                (rrect_cov(plate, radius, px, py), RING if ring else BG),
                (rrect_cov(plate_in, max(0.0, radius - ring), px, py) if ring else 0.0, BG),
                (rect_cov(outer, px, py), FG),
                (rect_cov(hole, px, py), BG),
                (rect_cov(bar, px, py), accent),
            )
            r = gg = b = a = 0.0  # 预乘 alpha，0..1
            for cov, col in layers:  # source-over，自下而上
                cov = min(1.0, cov)
                if cov <= 1e-9:
                    continue
                r = col[0] / 255 * cov + r * (1 - cov)
                gg = col[1] / 255 * cov + gg * (1 - cov)
                b = col[2] / 255 * cov + b * (1 - cov)
                a = cov + a * (1 - cov)
            if a > 0:
                i = (py * size + px) * 4
                out[i:i + 4] = bytes((q(r / a), q(gg / a), q(b / a), q(a)))
    return Image.frombytes("RGBA", (size, size), bytes(out))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Render icons/icon16/32/48/128.png (design C, high-contrast signal).")
    ap.add_argument("--accent", type=parse_accent, default=DEFAULT_ACCENT, metavar="#RRGGBB",
                    help="accent color of the divider bar, #RGB or #RRGGBB (default: %(default)s)")
    ap.add_argument("--out", type=Path, default=ROOT / "icons", help="output directory (default: icons/)")
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    accent_hex = "#%02X%02X%02X" % args.accent
    for s in SIZES:
        path = args.out / f"icon{s}.png"
        render(s, args.accent).save(path, optimize=True)
        print(f"wrote {path} ({s}x{s}, accent {accent_hex}, {path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
