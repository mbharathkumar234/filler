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

# ---------------------------------------------------------------------------
# `fixtures/images/passbook-holder-block.jpg`: a passbook laid out as the
# user's own is — and photographed as small, 780 pixels across, the size that
# read its IFSC a nought short, beside "SC COd:". The bank's name with
# the branch stamped under it, an empty "Branch Name & Address" box, the
# account number after "A/C No.", the holder's name, relation and address
# under one label, and the codes on the last line. Every value is made up but
# the codes: SBIN0000001 is a branch's public address (State Bank of India's
# Kolkata Main branch) and 700001 a post office's, which RBI's and India
# Post's lists are checked against.
# ---------------------------------------------------------------------------

BLOCK = OUT.parent / "passbook-holder-block.jpg"
TYPE = "C:/Windows/Fonts/cour.ttf"
TYPE_BOLD = "C:/Windows/Fonts/courbd.ttf"

page = Image.new("RGB", (780, 520), (246, 244, 240))
ink = ImageDraw.Draw(page)
purple = (92, 40, 120)
ink.text((60, 18), "STATE BANK OF INDIA", fill=purple, font=ImageFont.truetype(BOLD, 20))
ink.text((150, 44), "KOLKATA MAIN", fill=(60, 60, 70), font=ImageFont.truetype(TYPE, 15))
ink.rectangle((18, 70, 760, 500), outline=purple, width=3)
ink.line((480, 70, 480, 500), fill=purple, width=2)
small = ImageFont.truetype(FONT, 13)
ink.text((540, 82), "Branch Name & Address", fill=(70, 70, 80), font=small)
ink.text((496, 100), "Business Hours, Weekly Holidays, Telephone Nos.", fill=(70, 70, 80), font=ImageFont.truetype(FONT, 11))
typed = ImageFont.truetype(TYPE_BOLD, 17)
ink.text((28, 98), "SAVINGS BANK A/C No.: 30123456789012", fill=(25, 25, 25), font=typed)
lines = [
    "NAME AND ADDRESS OF THE ACCOUNT HOLDER/S:",
    "1.ARJUN MEHTA",
    "S/O RAKESH MEHTA,",
    "12 SAMPLE STREET,",
    "KOLKATA       700001 INDIA",
    "Customer-id: 1)123456789",
    "",
    "Operational Instructions: SELF",
    "Nomination Registration No: 117",
    "IFSC Code: SBIN0000001  MICR CODE:700002021  P.BRANCH MANAGER",
]
body = ImageFont.truetype(TYPE_BOLD, 14)
for index, line in enumerate(lines):
    ink.text((28, 140 + index * 26), line, fill=(25, 25, 25), font=body)

# A phone photo sent on: compressed, as the user's was.
page.save(BLOCK, quality=70)
print(f"wrote {BLOCK} ({BLOCK.stat().st_size} bytes)")
