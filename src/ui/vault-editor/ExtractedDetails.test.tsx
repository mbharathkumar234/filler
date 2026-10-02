// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExtractedDetails, sectionsOf } from './ExtractedDetails';
import { extractFromText } from '@/documents/extract';
import { labelFor } from '@/ui/lib/field-groups';
import type * as Client from '@/ui/lib/client';

/**
 * The suggestion screen, given a whole marks card (§ reading a document).
 *
 * A marks card is the case this screen was never built for: an ID card offers
 * two or three values, a marks card offers a dozen. The properties worth
 * pinning are the ones that stop a dozen rows becoming a dozen unread rows —
 * and the one that must survive any amount of convenience: **nothing is saved
 * until Save is pressed, and only what is ticked**.
 *
 * The candidates come from the real extractor rather than a fixture, so this
 * also fails if a rule starts proposing something with no home in the editor.
 */

const CARD = `
KARNATAKA SECONDARY EDUCATION EXAMINATION BOARD
S.S.L.C. MARKS CARD
REGISTER NUMBER : 1234567
STUDENT NAME : PRIYA S
FATHER NAME : SURESH KUMAR
MOTHER NAME : GEETHA
SCHOOL : GOVT HIGH SCHOOL TUMKUR
DATE OF BIRTH : 12-03-2007
SUBJECT MAX MARKS OBTAINED
KANNADA 125 110
ENGLISH 100 88
HINDI 100 90
MATHEMATICS 100 95
SCIENCE 100 92
SOCIAL SCIENCE 100 89
TOTAL 625 564
RESULT : PASS
`;

const extraction = extractFromText(CARD, { documentKey: 'doc.marksheet_10' });

const sent: { type: string; key?: string; value?: string }[] = [];

vi.mock('@/ui/lib/client', async () => {
  const actual = await vi.importActual<typeof Client>('@/ui/lib/client');
  return {
    ...actual,
    send: (request: { type: string; key?: string; value?: string }) => {
      sent.push(request);
      if (request.type === 'doc:extract') {
        return Promise.resolve({
          documentType: extraction.documentType,
          // One value carries the piece of the card it was read from.
          candidates: extraction.candidates.map((candidate) =>
            candidate.key === 'education.class_10.registration_number'
              ? { ...candidate, crop: 'AAAA' }
              : candidate,
          ),
          source: 'ocr',
          scripts: extraction.scripts,
          notes: extraction.notes,
          warnings: extraction.warnings,
          text: CARD,
          engineConfidence: 0.52,
        });
      }
      return Promise.resolve(null);
    },
  };
});

beforeEach(() => {
  sent.length = 0;
});

afterEach(cleanup);

async function open() {
  const user = userEvent.setup();
  render(
    <ExtractedDetails
      documentId="doc-1"
      documentLabel="Class 10 marks card"
      onLocked={() => {}}
      onSaved={() => {}}
      onClose={() => {}}
    />,
  );
  await waitFor(() => expect(sent.some((m) => m.type === 'doc:extract')).toBe(true));
  await screen.findByText(labelFor('education.class_10.registration_number'));
  return user;
}

describe('a dozen rows from one card', () => {
  it('groups them under the headings the vault editor uses', async () => {
    await open();

    // Titles come from field-groups so a relabel there does not fail this.
    expect(screen.getByText('Class 10 (SSLC / Matriculation)')).toBeTruthy();
    expect(screen.getByText('Identity')).toBeTruthy();
    expect(screen.getByText('Family')).toBeTruthy();
  });

  it('puts every proposed value in a group, never in a nameless one', () => {
    for (const section of sectionsOf(extraction.candidates)) {
      expect(section.id, section.rows.map((row) => row.key).join(', ')).not.toBe('other');
    }
  });

  it('orders the groups as the editor does', () => {
    const ids = sectionsOf(extraction.candidates).map((section) => section.id);
    expect(ids.indexOf('identity')).toBeLessThan(ids.indexOf('edu-class-10'));
  });

  it('shows the line each value was read from', async () => {
    await open();
    expect(screen.getAllByText(/^Read from:/).length).toBeGreaterThan(5);
  });
});

describe('what the screen will not do', () => {
  it('ticks nothing on a card that carries no checksum', async () => {
    await open();

    for (const box of screen.getAllByRole('checkbox')) {
      expect((box as HTMLInputElement).checked).toBe(false);
    }
    expect(screen.getByRole('button', { name: 'Tick what to save' })).toBeTruthy();
  });

  it('writes nothing to the vault until Save is pressed', async () => {
    const user = await open();

    await user.click(screen.getAllByRole('button', { name: /^Tick all/ })[0]!);
    expect(sent.filter((m) => m.type === 'vault:set')).toHaveLength(0);
  });

  it('saves only the group the user ticked', async () => {
    const user = await open();

    // The Class 10 group is the long one; tick it and nothing else.
    const tickAll = screen.getAllByRole('button', { name: /^Tick all/ });
    const classTen = tickAll[tickAll.length - 1]!;
    await user.click(classTen);
    await user.click(screen.getByRole('button', { name: /^Save \d+ detail/ }));

    const saved = sent.filter((m) => m.type === 'vault:set').map((m) => m.key!);
    expect(saved.length).toBeGreaterThan(3);
    for (const key of saved) expect(key.startsWith('education.class_10.')).toBe(true);
  });
});

describe('what the engine actually read', () => {
  /*
   * The escape hatch. Recognition on a photograph is never perfect, and being
   * able to see the text is the difference between copying the one value the
   * rules missed and being told only that nothing was found.
   */
  it('offers the text behind a disclosure, and says when the picture was hard', async () => {
    await open();

    const summary = screen.getByText(/Show the text that was read/);
    expect(summary.textContent).toMatch(/struggled with this picture/);
  });
});

describe('what it says it could not save', () => {
  it('passes the reader’s own notes through to the screen', async () => {
    await open();
    // Three languages on the card, one language box in the vault: the third is
    // read, kept in the subject list, and said to be.
    expect(screen.getByText(/saved only in the subject list: HINDI/i)).toBeTruthy();
  });

  it('says once that a recognised reading must be checked', async () => {
    // Driven through the real panel, it said so twice, one line under the
    // other: once from how the reading was made, once as a note of its own.
    await open();
    expect(screen.getAllByText(/compare each value|check each value/i)).toHaveLength(1);
  });
});

describe('the shape of a row', () => {
  /*
   * Detail against value, with the tick at the end of the pair. Checking a
   * reading against the card in your hand is reading across a line; a column of
   * labels stacked over a column of boxes makes it reading down a page.
   */
  it('puts the label, then the value, then the tick', async () => {
    await open();

    // Both controls in the row carry the same label, which is the point of it:
    // the tick is the tick *for that detail*. Find the row by the value box.
    const value = document.getElementById('extract-education.class_10.registration_number')!;
    const row = value.closest('li')!;
    const controls = [...row.querySelectorAll('textarea, input')];
    expect(controls).toHaveLength(2);
    expect(controls[0]).toBe(value);
    expect((controls[1] as HTMLInputElement).type).toBe('checkbox');
  });

  it('heads each group with what the two columns are', async () => {
    await open();
    expect(screen.getAllByText('Value read').length).toBeGreaterThan(0);
  });

  it('shows the whole value, however long, rather than the start of it', async () => {
    // In the real side panel the value column is about a hundred pixels wide.
    // A one-line box showed "M Kiran Kum" of a name and "CENTRAL BOARD O" of
    // a board — the rest scrolled out of sight, on the screen whose one job is
    // comparing the value with the card. A box that wraps shows all of it.
    await open();
    const board = document.getElementById('extract-education.class_10.board_or_university')!;
    expect(board.tagName).toBe('TEXTAREA');
  });

  it('never puts a line break into a value', async () => {
    // It wraps like a paragraph and saves like the one line it is: Enter does
    // nothing, and a line break pasted in becomes a space.
    const user = await open();
    const school = document.getElementById('extract-education.class_10.institution') as HTMLTextAreaElement;
    await user.clear(school);
    await user.type(school, 'GOVT HIGH SCHOOL{Enter}');
    await user.paste('TUMKUR\nTALUK');
    expect(school.value).toBe('GOVT HIGH SCHOOLTUMKUR TALUK');
  });
});

describe('the piece of the card a value was read from', () => {
  /*
   * A misread digit is misread in the value and in the quoted line alike; the
   * picture is the one thing on this screen the reader did not produce.
   */
  it('shows the picture beside the value it belongs to', async () => {
    await open();
    const picture = screen.getByRole('img', { name: /Registration number/i }) as HTMLImageElement;
    expect(picture.src).toBe('data:image/jpeg;base64,AAAA');
    expect(picture.closest('li')).toBe(
      document.getElementById('extract-education.class_10.registration_number')!.closest('li'),
    );
  });

  it('shows no picture for a value that has none, and still quotes its line', async () => {
    await open();
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getAllByText(/^Read from:/).length).toBeGreaterThan(5);
  });

  it('gives the picture the width of the whole row, not the value’s column', async () => {
    // Squeezed into the value's column the picture was shrunk to a hundred
    // pixels, and a row of a marks table came out as an unreadable sliver.
    await open();
    const picture = screen.getByRole('img', { name: /Registration number/i });
    const value = document.getElementById('extract-education.class_10.registration_number')!;
    expect(picture.closest('div')?.contains(value)).toBe(false);
    expect(picture.closest('[data-evidence]')).not.toBeNull();
  });
});
