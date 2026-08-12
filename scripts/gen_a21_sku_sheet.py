import json
import math
import qrcode
from PIL import Image, ImageDraw, ImageFont

with open('/tmp/a21.json') as f:
    data = json.load(f)
rows = data['rows']

MISMATCH_SKUS = [
    ('SKU-1042', 'Steel Bracket 90'),
    ('SKU-2218', 'Pallet Support Pin'),
    ('SKU-3301', 'Plastic Crate Blue'),
    ('SKU-9011', 'Rack Label Kit'),
    ('SKU-5088', 'Corner Protector'),
    ('SKU-1180', 'Fastener Pack M10'),
]
MISMATCH_INDICES = [4, 10, 16, 22, 28, 34]

for i, row in enumerate(rows):
    if i in MISMATCH_INDICES:
        pos = MISMATCH_INDICES.index(i)
        sku, name = MISMATCH_SKUS[pos % len(MISMATCH_SKUS)]
        row['scanSku'] = sku
        row['scanName'] = name
        row['result'] = 'MISMATCH'
    else:
        row['scanSku'] = 'SKU-1001'
        row['scanName'] = 'iPhone 15 Box'
        row['result'] = 'MATCH'

try:
    font_bold = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 20, index=1)
    font_reg = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 16)
    font_sm = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 14)
    font_title = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 26, index=1)
except Exception:
    font_bold = font_reg = font_sm = font_title = ImageFont.load_default()

COLS = 3
ROWS_PER_PAGE = 4
PER_PAGE = COLS * ROWS_PER_PAGE  # 12
CELL_W = 340
CELL_H = 330
MARGIN = 24
HEAD_H = 70

pages = math.ceil(len(rows) / PER_PAGE)

for page in range(pages):
    page_rows = rows[page * PER_PAGE:(page + 1) * PER_PAGE]
    n = len(page_rows)
    grid_rows = math.ceil(n / COLS)
    W = MARGIN * 2 + COLS * CELL_W
    H = HEAD_H + MARGIN * 2 + grid_rows * CELL_H
    img = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(img)
    d.text((MARGIN, 20), f'Rack A-21 — SKU Scan Sheet (Page {page + 1}/{pages})', font=font_title, fill='black')
    d.text((MARGIN, 52), 'Select the pallet on canvas first, then scan the QR below to record its SKU.', font=font_sm, fill='#555555')

    for idx, row in enumerate(page_rows):
        c = idx % COLS
        r = idx // COLS
        x = MARGIN + c * CELL_W
        y = HEAD_H + MARGIN + r * CELL_H
        d.rectangle([x, y, x + CELL_W - 16, y + CELL_H - 16], outline='#cccccc', width=1)

        pad = 14
        ty = y + pad
        d.text((x + pad, ty), row['code'], font=font_bold, fill='black')
        ty += 26
        d.text((x + pad, ty), f"Bay {row['bay']} · L{row['level']} · P-{row['level']:02d}{row['slot']:02d}", font=font_sm, fill='#555555')
        ty += 22

        qr = qrcode.make(row['scanSku'])
        qr = qr.resize((150, 150))
        img.paste(qr, (x + pad, ty))

        tx = x + pad + 150 + 14
        ty2 = ty
        d.text((tx, ty2), 'Scan encodes:', font=font_sm, fill='#555555')
        ty2 += 20
        d.text((tx, ty2), row['scanSku'], font=font_bold, fill='black')
        ty2 += 24
        # wrap name manually if long
        d.text((tx, ty2), row['scanName'][:16], font=font_sm, fill='#555555')

        badge_color = '#1a7f37' if row['result'] == 'MATCH' else '#c0392b'
        by = ty + 150 + 14
        d.rectangle([x + pad, by, x + pad + 110, by + 26], fill=badge_color)
        d.text((x + pad + 10, by + 4), row['result'], font=font_sm, fill='white')
        d.text((x + pad + 120, by + 4), f"Expects SKU-1001", font=font_sm, fill='#888888')

    out = f"/Users/rams/Desktop/Rack Audit/qr-codes/a21-sku-scan-sheet-page{page + 1}.png"
    img.save(out)
    print('saved', out, img.size)

# Summary text file
with open('/Users/rams/Desktop/Rack Audit/qr-codes/a21-sku-scan-sheet-answer-key.txt', 'w') as f:
    f.write('Rack A-21 SKU Scan Sheet — Answer Key\n')
    f.write('Expected SKU at every listed location: SKU-1001 (iPhone 15 Box)\n\n')
    for row in rows:
        f.write(f"{row['code']:20s} Bay {row['bay']} L{row['level']:>2} P-{row['level']:02d}{row['slot']:02d}   scan={row['scanSku']:10s} -> {row['result']}\n")

print('match count:', sum(1 for r in rows if r['result'] == 'MATCH'))
print('mismatch count:', sum(1 for r in rows if r['result'] == 'MISMATCH'))
