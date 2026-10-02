"""
Generate the locked-PDF fixtures: `fixtures/pdf/locked-aadhaar.pdf` and
`fixtures/pdf/owner-locked.pdf`.

An e-Aadhaar is downloaded password-protected, and a reader that cannot open it
reads nothing. These two stand in for it, with made-up details only:

- `locked-aadhaar.pdf` opens with the password `RAVI1998` (AES-256, as UIDAI's
  own downloads are). It carries an e-Aadhaar's lines as real text, so reading
  it exactly, through its text layer, is what the tests check.
- `owner-locked.pdf` has an owner password and no user password: it opens
  without asking, as many government PDFs do, and must never be met with a
  password prompt.

Python, because the Node packages this repository uses cannot encrypt a PDF.
Needs `pip install pypdf cryptography`. The outputs are committed, so running
the tests needs neither.

Usage: python scripts/make-locked-pdf-fixtures.py
"""

from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, StreamObject

OUT = Path(__file__).resolve().parent.parent / "fixtures" / "pdf"

# Made up, every line. 999999990019 is UIDAI's published test number: it passes
# the Verhoeff check and belongs to nobody.
AADHAAR_LINES = [
    "Unique Identification Authority of India",
    "Enrolment No.: 1234/56789/01234",
    "To",
    "Ravi Kumar",
    "S/O: Suresh Kumar",
    "Your Aadhaar No. :",
    "9999 9999 0019",
    "Ravi Kumar",
    "DOB: 14/03/1998",
    "MALE",
]

PLAIN_LINES = [
    "Government of Karnataka",
    "Certificate stand-in for an owner-locked PDF",
    "Name : Priya S",
]


def page_with_lines(writer: PdfWriter, lines: list[str]) -> None:
    page = writer.add_blank_page(width=595, height=842)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})}
    )
    shown = "\n".join(f"({line}) Tj T*" for line in lines)
    content = StreamObject()
    content.set_data(f"BT /F1 14 Tf 60 780 Td 22 TL\n{shown}\nET".encode("latin-1"))
    page[NameObject("/Contents")] = writer._add_object(content)


def write(name: str, lines: list[str], user_password: str, owner_password: str, algorithm: str) -> None:
    writer = PdfWriter()
    page_with_lines(writer, lines)
    writer.encrypt(user_password=user_password, owner_password=owner_password, algorithm=algorithm)
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / name, "wb") as handle:
        writer.write(handle)
    print(f"wrote {OUT / name}")


write("locked-aadhaar.pdf", AADHAAR_LINES, "RAVI1998", "fixture-owner-password", "AES-256")
write("owner-locked.pdf", PLAIN_LINES, "", "fixture-owner-password", "AES-128")
