# -*- coding: utf-8 -*-
"""生成 蜜蜂信息采集 的应用图标 build/icon.ico

设计：琥珀色蜂巢六边形 + 一只白色翅膀的卡通蜜蜂（脸朝你）。
为什么要「画」一个：装完之后桌面、任务栏、Alt+Tab 上看到的都是它，
一眼认出是「蜜蜂信息采集」比什么都重要。

改完这个文件重跑一次即可覆盖 build/icon.ico 与 build/icon.png。
"""
import math
import os

from PIL import Image, ImageDraw

SS = 4           # 超采样倍数（画 4 倍大再缩回来，边缘不毛）
S = 512 * SS
CX = S / 2
CY = S / 2
R = S * 0.46     # 六边形外接半径


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def flat_top_hex(radius):
    """平顶六边形（上下各一个尖），蜂巢的经典形状"""
    pts = []
    for i in range(6):
        a = math.pi / 2 + i * math.pi / 3
        pts.append((CX + radius * math.cos(a), CY + radius * math.sin(a)))
    return pts


def wing(size, angle):
    """一片半透明的翅膀；size = 长径，angle = 上扬角度"""
    w, h = int(size), int(size * 0.56)
    layer = Image.new('RGBA', (w * 2, h * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse((0, 0, w * 2 - 1, h * 2 - 1),
              fill=(255, 255, 255, 168),
              outline=(146, 112, 52, 130), width=int(S * 0.009))
    return layer.rotate(angle, expand=True, resample=Image.BICUBIC)


def main():
    # ---------------- 蜂巢底 ----------------
    top, bottom = (255, 208, 66), (226, 124, 0)
    grad = Image.new('RGB', (S, S), top)
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        gd.line([(0, y), (S, y)], fill=lerp(top, bottom, y / max(1, S - 1)))

    poly = flat_top_hex(R)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).polygon(poly, fill=255)
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    edge = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(edge).polygon(poly, outline=(122, 63, 0, 255), width=int(S * 0.024))
    img.alpha_composite(edge)

    # ---------------- 小蜜蜂 ----------------
    bee = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # ① 翅膀先画（在头后面，露出来的部分才自然）
    for sign in (-1, 1):
        w = wing(int(S * 0.225), -25 * sign)
        cx = CX + sign * int(S * 0.265)
        cy = CY - int(S * 0.185)
        bee.alpha_composite(w, (int(cx - w.width / 2), int(cy - w.height / 2)))

    # ② 身体（竖着的椭圆形）+ 只留身体范围内的条纹
    body_box = (int(S * 0.34), int(S * 0.42), int(S * 0.66), int(S * 0.845))
    body_mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(body_mask).ellipse(body_box, fill=255)
    ImageDraw.Draw(bee).ellipse(body_box, fill=(43, 32, 22, 255))

    stripe = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stripe)
    h = body_box[3] - body_box[1]
    for fy, th in ((0.55, 0.115),):
        y = body_box[1] + h * fy
        sd.rectangle([body_box[0], y - S * th / 2, body_box[2], y + S * th / 2],
                     fill=(255, 192, 44, 255))
    stripe.putalpha(Image.composite(stripe.getchannel('A'),
                                    Image.new('L', (S, S), 0), body_mask))
    bee.alpha_composite(stripe)

    # ③ 头（大圆，卡通比例）+ 眼睛 + 触角
    head_box = (int(S * 0.255), int(S * 0.185), int(S * 0.745), int(S * 0.625))
    ImageDraw.Draw(bee).ellipse(head_box, fill=(38, 28, 20, 255))

    for k in (-1, 1):
        ex = CX + k * int(S * 0.118)
        ey = CY - int(S * 0.035)
        r = int(S * 0.058)
        ImageDraw.Draw(bee).ellipse((ex - r, ey - r, ex + r, ey + r), fill=(255, 255, 255, 245))
        r2 = int(r * 0.46)
        ImageDraw.Draw(bee).ellipse((ex - r2, ey - r2 + int(S * 0.010), ex + r2, ey + r2 + int(S * 0.010)),
                                    fill=(40, 30, 22, 255))

    # 触角：从头顶伸出来两根小天线
    for k in (-1, 1):
        base = (CX + k * int(S * 0.075), CY - int(S * 0.215))
        tip = (CX + k * int(S * 0.145), CY - int(S * 0.335))
        ImageDraw.Draw(bee).line([base, tip], fill=(43, 32, 22, 255), width=int(S * 0.016))
        r = int(S * 0.026)
        ImageDraw.Draw(bee).ellipse((tip[0] - r, tip[1] - r, tip[0] + r, tip[1] + r),
                                    fill=(43, 32, 22, 255))

    # ④ 额头一条浅色高光，让它看起来是"圆球"而不是"平片"
    gloss = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(gloss).ellipse((int(S * 0.315), int(S * 0.225), int(S * 0.685), int(S * 0.375)),
                                  fill=(255, 255, 255, 32))
    bee.alpha_composite(gloss)

    img.alpha_composite(bee)

    # ---------------- 缩回 512 并导出 ----------------
    out = img.resize((512, 512), Image.LANCZOS)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    build = os.path.join(root, 'build')
    os.makedirs(build, exist_ok=True)
    png = os.path.join(build, 'icon.png')
    ico = os.path.join(build, 'icon.ico')
    out.save(png)
    out.save(ico, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    print('已生成：', png)
    print('已生成：', ico)


if __name__ == '__main__':
    main()
