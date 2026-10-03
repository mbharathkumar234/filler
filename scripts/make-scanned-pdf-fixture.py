"""
Generate `fixtures/pdf/scanned-three-pages.pdf`: a scanned PUC marks card in
three pages, with made-up details only.

A scanned PDF has no text layer — every page is a picture — so reading it means
rendering each page and recognising it. The three pages are stored the three
ways scanners store pages, and each needs something the reader once lacked:

- page 1, colour, as JPEG (`DCTDecode`): the common case;
- page 2, black and white, as CCITT Group 4 fax (`CCITTFaxDecode`), and turned
  a quarter clockwise, as a page fed into the scanner sideways is. pdf.js
  decodes fax images with `jbig2.wasm`; without it the page renders blank;
- page 3, as JPEG 2000 (`JPXDecode`), which pdf.js decodes with `openjpeg.wasm`.

Pillow chooses those encodings by image mode ("RGB", "1", "RGBA"); it needs
libtiff for the fax page. The text is drawn in Arial, so the script runs where
Arial is installed (Windows has it). The output is committed; running the tests
needs neither.

Usage: python scripts/make-scanned-pdf-fixture.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, features

OUT = Path(__file__).resolve().parent.parent / "fixtures" / "pdf" / "scanned-three-pages.pdf"
FONT = "C:/Windows/Fonts/arial.ttf"
WIDTH, HEIGHT = 1240, 1754  # A4 at 150 dots per inch

assert features.check("libtiff"), "Pillow needs libtiff to write the fax-compressed page."


def page(lines: list[str], mode: str) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), (250, 248, 240))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(FONT, 34)
    y = 140
    for line in lines:
        draw.text((110, y), line, fill=(20, 20, 20), font=font)
        y += 70
    if mode == "1":
        return image.convert("L").point(lambda v: 255 if v > 128 else 0).convert("1")
    if mode == "RGBA":
        return image.convert("RGBA")
    return image


# Made up, every line: no real student, college or register number.
first = page(
    [
        "GOVERNMENT OF KARNATAKA",
        "DEPARTMENT OF PRE-UNIVERSITY EDUCATION",
        "MARKS CARD - II PUC EXAMINATION APRIL 2022",
        "Candidate's Name : PRIYA S",
        "Register No. : 765432",
        "College : SRI VIDYA PU COLLEGE, TUMKUR",
    ],
    "RGB",
)
second = page(
    [
        "SUBJECT MAX MARKS OBTAINED",
        "KANNADA 765432 APR2022 100 91 91 NINE ONE",
        "ENGLISH 765432 APR2022 100 82 82 EIGHT TWO",
        "PHYSICS 765432 APR2022 100 81 81 EIGHT ONE",
        "CHEMISTRY 765432 APR2022 100 77 77 SEVEN SEVEN",
        "MATHEMATICS 765432 APR2022 100 88 88 EIGHT EIGHT",
        "BIOLOGY 765432 APR2022 100 90 90 NINE ZERO",
    ],
    "1",
).rotate(-90, expand=True)  # a quarter clockwise: fed into the scanner sideways
third = page(
    [
        "Total Marks : 600 509 509",
        "RESULT : DISTINCTION",
        "Date : 21.06.2022",
    ],
    "RGBA",
)

OUT.parent.mkdir(parents=True, exist_ok=True)
first.save(OUT, "PDF", resolution=150, save_all=True, append_images=[second, third])
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
