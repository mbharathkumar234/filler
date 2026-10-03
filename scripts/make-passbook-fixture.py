"""
Generate `fixtures/images/passbook.jpg`: the front page of a bank passbook,
made up — a bank that does not exist, an IFSC no bank has, a name and an
account number belonging to nobody.

It is the shape that broke the preview: a landscape page, previewed against a
passport photo's 3.5 x 4.5 cm and cut down the middle to fit. A document must
come out whole, so the test previews this and measures what comes back.

Drawn in Arial, so the script runs where Arial is installed (Windows has it).
The output is committed; running the tests needs neither.

Usage: python scripts/make-passbook-fixture.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "fixtures" / "images" / "passbook.jpg"
FONT = "C:/Windows/Fonts/arial.ttf"
BOLD = "C:/Windows/Fonts/arialbd.ttf"

image = Image.new("RGB", (1600, 1000), (236, 228, 244))
draw = ImageDraw.Draw(image)
draw.text((60, 50), "SAMPLE BANK (A MADE-UP BANK)", fill=(60, 20, 90), font=ImageFont.truetype(BOLD, 48))
body = ImageFont.truetype(FONT, 40)
for index, line in enumerate(
    [
        "Branch : TUMKUR MAIN",
        "IFSC : SMPL0001234",
        "Account Holder : PRIYA S",
        "Account No. : 12345678901",
        "Type : SAVINGS",
    ]
):
    draw.text((60, 170 + index * 110), line, fill=(20, 20, 20), font=body)
draw.rectangle((1150, 200, 1500, 600), outline=(60, 20, 90), width=6)
draw.text((1215, 380), "PHOTO", fill=(60, 20, 90), font=body)

OUT.parent.mkdir(parents=True, exist_ok=True)
image.save(OUT, quality=90)
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
