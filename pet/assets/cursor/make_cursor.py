"""把 source.png（画进图里的灰白格子"假透明"）抠成真透明，裁到内容，
再缩成光标用的 PNG 和 .cur（热点在箭头尖）。用法：python make_cursor.py"""
import io
import struct
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).parent
SIZES = (32, 48, 64)

img = np.array(Image.open(HERE / 'source.png').convert('RGB')).astype(int)
h, w, _ = img.shape
r, g, b = img[..., 0], img[..., 1], img[..., 2]
# 格子是浅灰和白，几乎没有颜色；人物和箭头都有深蓝描边把里面围起来
neutral = (np.abs(r - g) < 18) & (np.abs(g - b) < 18) & (np.abs(r - b) < 18) & (r > 110)

# 从四条边往里漫水，只吃连通的"无色浅色"，描边挡住，箭头里面的白不会被吃掉
bg = np.zeros((h, w), bool)
q = deque((y, x) for y in range(h) for x in (0, w - 1)) + deque((y, x) for x in range(w) for y in (0, h - 1))
while q:
    y, x = q.popleft()
    if bg[y, x] or not neutral[y, x]:
        continue
    bg[y, x] = True
    if y > 0: q.append((y - 1, x))
    if y < h - 1: q.append((y + 1, x))
    if x > 0: q.append((y, x - 1))
    if x < w - 1: q.append((y, x + 1))

# 被描边围住的小洞（比如呆毛圈里）漫水进不去；格子是深浅两种灰交替，按"一块无色区域里明暗差得多"认出来
seen = bg.copy()
for sy, sx in zip(*np.where(neutral & ~bg)):
    if seen[sy, sx]:
        continue
    comp, q = [], deque([(sy, sx)])
    seen[sy, sx] = True
    while q:
        y, x = q.popleft()
        comp.append((y, x))
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and neutral[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    vals = np.array([r[p] for p in comp])
    if len(comp) > 200 and vals.std() > 15:
        for p in comp:
            bg[p] = True

rgba = np.dstack([img, np.where(bg, 0, 255)]).astype(np.uint8)
out = Image.fromarray(rgba, 'RGBA')
ys, xs = np.where(~bg)
box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
out = out.crop(box)

# 箭头尖：最左边那一列里最靠上的不透明像素（箭头是整张图最左的东西）
a = np.array(out)[..., 3]
col = np.where(a.any(axis=0))[0][0]
tip = (int(col), int(np.where(a[:, col])[0][0]))
side = max(out.size)
square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
square.paste(out, (0, 0))  # 左上对齐，箭头尖靠近左上角
square.save(HERE / 'cursor-clean.png')
print('cropped', out.size, 'tip in cropped', tip)


def cur_file(img, size, hx, hy):
    # 先存成 BMP 格式的 .ico，再把类型改成光标（2）、把热点写进 planes / bitcount 的位置。
    # PNG 压缩的 .cur LoadImage 读不了，必须用 BMP
    buf = io.BytesIO()
    img.save(buf, 'ICO', sizes=[(size, size)], bitmap_format='bmp')
    b = bytearray(buf.getvalue())
    struct.pack_into('<H', b, 2, 2)
    struct.pack_into('<HH', b, 6 + 4, hx, hy)
    return bytes(b)


for s in SIZES:
    small = square.resize((s, s), Image.LANCZOS)
    small.save(HERE / f'cursor-{s}.png')
    hx, hy = round(tip[0] * s / side), round(tip[1] * s / side)
    (HERE / f'cursor-{s}.cur').write_bytes(cur_file(small, s, hx, hy))
    print(f'{s}px hotspot', hx, hy)
