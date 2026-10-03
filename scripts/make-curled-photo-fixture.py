"""
A made-up marks card, photographed badly: the page curled, tilted, lying on a
table, lit from one side. For the scanner's tests (Stage 2: flattening a phone
photo before it is read or sent to a portal).

The flat card is drawn by Chromium (`make-curled-photo-fixture.mjs` writes
`fixtures/images/flat-marks-card.png`); this bends it the way paper bends.
Every name, number and institution on it is invented.

Usage: python scripts/make-curled-photo-fixture.py
"""

import os

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
IMAGES = os.path.join(HERE, '..', 'fixtures', 'images')

flat = cv2.imread(os.path.join(IMAGES, 'flat-marks-card.png'))
h, w = flat.shape[:2]

# 1. The curl: each column lifts as the page bows, more at the right edge, and
#    the text there is foreshortened — a page lying open, not flat.
rng = np.random.default_rng(7)
pad = 120
canvas_h, canvas_w = h + 2 * pad, w + 2 * pad
ys, xs = np.mgrid[0:canvas_h, 0:canvas_w].astype(np.float32)
u = (xs - pad) / w
v = (ys - pad) / h
bow = 38.0 * np.sin(np.pi * np.clip(u, 0, 1)) * (0.6 + 0.4 * v)
droop = 26.0 * (np.clip(u, 0, 1) ** 2)
map_x = xs - pad
map_y = ys - pad - bow + droop * (v - 0.5)
curled = cv2.remap(flat, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
mask = cv2.remap(np.full((h, w), 255, np.uint8), map_x, map_y, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0)

# 2. The table, a little textured.
table = np.zeros((canvas_h, canvas_w, 3), np.float32)
table[:] = (72, 96, 128)
table += rng.normal(0, 6, table.shape).astype(np.float32)
table = cv2.GaussianBlur(table, (0, 0), 3)
page = np.where(mask[..., None] > 0, curled.astype(np.float32), table)

# 3. The phone held at an angle: a perspective tilt.
src = np.float32([[0, 0], [canvas_w, 0], [canvas_w, canvas_h], [0, canvas_h]])
dst = np.float32([[60, 40], [canvas_w - 20, 90], [canvas_w - 90, canvas_h - 30], [30, canvas_h - 70]])
tilted = cv2.warpPerspective(page, cv2.getPerspectiveTransform(src, dst), (canvas_w, canvas_h),
                             borderMode=cv2.BORDER_REPLICATE)

# 4. Light from the left, a soft shadow on the right, a little sensor noise.
light = np.linspace(1.08, 0.78, canvas_w, dtype=np.float32)[None, :, None]
photo = tilted * light + rng.normal(0, 4, tilted.shape).astype(np.float32)
photo = cv2.GaussianBlur(photo, (0, 0), 0.8)
photo = np.clip(photo, 0, 255).astype(np.uint8)

out = os.path.join(IMAGES, 'curled-marks-card.jpg')
cv2.imwrite(out, photo, [cv2.IMWRITE_JPEG_QUALITY, 85])
print('wrote', os.path.relpath(out, os.path.join(HERE, '..')))
