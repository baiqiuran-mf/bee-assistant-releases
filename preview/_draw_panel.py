# -*- coding: utf-8 -*-
"""2.6.1185 右栏「对话信息」面板模拟截图：用生产库真实消息渲染（缩略图 75px，与软件一致）。"""
import json, os
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(BASE, 'preview', '_conv', 'data.json'), encoding='utf-8'))

FONT = r'C:\Windows\Fonts\msyh.ttc'
def f(sz, bold=False):
    try: return ImageFont.truetype(FONT, sz)
    except Exception: return ImageFont.load_default()

W = 460
pad = 16
row_gap = 12

def load_img(name):
    p = os.path.join(BASE, 'preview', '_conv', name)
    if os.path.exists(p):
        return Image.open(p).convert('RGB')
    return None

# 预计算布局高度
def msg_height(kind, has_img=False, en=False, zh=False, btn=False):
    h = 14
    if zh: h += 22
    if en: h += 18
    if has_img: h = max(h, 75)
    if btn: h += 26
    return h + 14

items = []  # (kind, ...)
# 媒体带（顶部一行 4 张）
items.append(('strip', data['media']))
# in 文字 1
if data['inTxt']:
    items.append(('in', data['inTxt'][0]))
# in 图片
items.append(('in_img', data['media'][1] if len(data['media'])>1 else data['media'][0]))
# in 视频
items.append(('in_video', data['media'][0]))
# in 语音
items.append(('in_ptt',))
# out 文字 1
if data['outTxt']:
    items.append(('out', data['outTxt'][0]))
# in 文字 2
if len(data['inTxt'])>1:
    items.append(('in', data['inTxt'][1]))
# out 文字 2
if len(data['outTxt'])>1:
    items.append(('out', data['outTxt'][1]))

H = 70  # 标题
for it in items:
    k = it[0]
    if k == 'strip': H += 75 + 12
    elif k in ('in','out'): H += msg_height('x', en=True, zh=True, btn=(k=='in')) + row_gap
    elif k in ('in_img','in_video'): H += 75 + 30 + row_gap
    elif k == 'in_ptt': H += 56 + row_gap
H += 30

img = Image.new('RGB', (W, H), '#ffffff')
d = ImageDraw.Draw(img)
THUMB = 75

# 标题栏
d.rectangle((0,0,W,52), fill='#3a5bbf')
d.text((pad, 14), '对话信息', font=f(18, True), fill='#ffffff')
d.text((W-110, 18), 'WA②', font=f(13), fill='#dce4ff')

y = 60
# 媒体带
if items and items[0][0]=='strip':
    strip = items[0][1]
    d.rectangle((0, y, W, y+THUMB+12), fill='#f6f8fa')
    x = pad
    for m in strip:
        im = load_img(m['file'])
        if im:
            tw = THUMB; th = THUMB
            im = im.resize((tw, th), Image.LANCZOS)
            img.paste(im, (x, y+6))
            d.rectangle((x, y+6, x+tw-1, y+6+th-1), outline='#d5dbe1')
            if m['type']=='video':
                d.rounded_rectangle((x+4, y+6+th-22, x+50, y+6+th-6), radius=4, fill='#000000')
                d.text((x+8, y+6+th-19), '视频', font=f(11), fill='#fff')
        x += THUMB + 6
    y += THUMB + 12 + row_gap

def draw_bubble(y, side, zh, en, show_btn, extra=None):
    # 卡片
    cx = pad if side=='in' else W//2
    cw = W - pad - cx
    ch = 14
    if zh: ch += 22
    if en: ch += 18
    if show_btn: ch += 26
    if extra: ch += 24
    x0 = cx if side=='in' else (W - pad - cw)
    d.rounded_rectangle((x0, y, x0+cw, y+ch), radius=10, fill='#f5f8ff' if side=='in' else '#eef9f1', outline='#dfe6f2')
    yy = y+10
    if zh:
        d.text((x0+12, yy), zh, font=f(13, True), fill='#1f6aa5' if side=='in' else '#1d8a4f')
        yy += 22
    if en:
        # 换行裁剪
        en = en[:60] + ('…' if len(en)>60 else '')
        d.text((x0+12, yy), en, font=f(12), fill='#555')
        yy += 18
    if extra:
        d.text((x0+12, yy), extra, font=f(12), fill='#b35')
        yy += 24
    if show_btn:
        bx0 = x0 + cw - 64
        d.rounded_rectangle((bx0, y+ch-28, bx0+52, y+ch-8), radius=13, fill='#eef3ff', outline='#4f7cff')
        d.text((bx0+12, y+ch-24), '建议', font=f(11), fill='#4f7cff')
    return y + ch + row_gap

for it in items[1:]:
    k = it[0]
    if k == 'in':
        t = it[1]
        y = draw_bubble(y, 'in', t.get('zh','') or None, t.get('en',''), True)
    elif k == 'out':
        t = it[1]
        y = draw_bubble(y, 'out', t.get('zh','') or None, t.get('en',''), False)
    elif k == 'in_img':
        m = it[1]
        im = load_img(m['file'])
        ch = THUMB + 30
        x0 = pad; cw = W - 2*pad
        d.rounded_rectangle((x0, y, x0+cw, y+ch), radius=10, fill='#f5f8ff', outline='#dfe6f2')
        if im:
            im = im.resize((THUMB, THUMB), Image.LANCZOS)
            img.paste(im, (x0+12, y+10))
            d.rectangle((x0+12, y+10, x0+12+THUMB-1, y+10+THUMB-1), outline='#d5dbe1')
        d.text((x0+12+THUMB+10, y+12), '图片', font=f(13), fill='#333')
        d.text((x0+12+THUMB+10, y+34), '点开看大图', font=f(12), fill='#4f7cff')
        bx0 = x0 + cw - 64
        d.rounded_rectangle((bx0, y+ch-28, bx0+52, y+ch-8), radius=13, fill='#eef3ff', outline='#4f7cff')
        d.text((bx0+12, y+ch-24), '建议', font=f(11), fill='#4f7cff')
        y += ch + row_gap
    elif k == 'in_video':
        m = it[1]
        im = load_img(m['file'])
        ch = THUMB + 30
        x0 = pad; cw = W - 2*pad
        d.rounded_rectangle((x0, y, x0+cw, y+ch), radius=10, fill='#f5f8ff', outline='#dfe6f2')
        if im:
            im = im.resize((THUMB, THUMB), Image.LANCZOS)
            img.paste(im, (x0+12, y+10))
            d.rectangle((x0+12, y+10, x0+12+THUMB-1, y+10+THUMB-1), outline='#d5dbe1')
            d.rounded_rectangle((x0+16, y+10+THUMB-22, x0+16+46, y+10+THUMB-6), radius=4, fill='#000000')
            d.text((x0+20, y+10+THUMB-19), '视频', font=f(11), fill='#fff')
        d.text((x0+12+THUMB+10, y+12), '视频缩略图', font=f(13), fill='#333')
        d.text((x0+12+THUMB+10, y+34), '点开看大图', font=f(12), fill='#4f7cff')
        bx0 = x0 + cw - 64
        d.rounded_rectangle((bx0, y+ch-28, bx0+52, y+ch-8), radius=13, fill='#eef3ff', outline='#4f7cff')
        d.text((bx0+12, y+ch-24), '建议', font=f(11), fill='#4f7cff')
        y += ch + row_gap
    elif k == 'in_ptt':
        ch = 56
        x0 = pad; cw = W - 2*pad
        d.rounded_rectangle((x0, y, x0+cw, y+ch), radius=10, fill='#fdf2f2', outline='#e7c4c4')
        d.text((x0+12, y+10), '语音 · 已收到这条语音', font=f(12, True), fill='#b35')
        d.text((x0+12, y+30), '内容没能取回（WhatsApp 语音文件有时效，过期就取不回来）', font=f(11), fill='#b35')
        y += ch + row_gap

out = os.path.join(BASE, '2.6.1185-右栏对话信息面板.png')
img.save(out)
print('saved', out, img.size)
