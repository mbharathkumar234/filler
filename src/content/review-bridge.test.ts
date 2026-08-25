// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyEdit, collectValues, focusField } from './review-bridge';

/**
 * The page's half of the review screen.
 *
 * The load-bearing assertion here is that showing the user a field does not
 * *change* it. The harvester makes that promise for reading; the review has to
 * make it for pointing, because a portal that can detect us outlining its
 * inputs — or whose validation fires because we set a style — would be broken
 * by the very screen meant to protect the user from a broken form.
 */

function page(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

const FORM = `
  <form>
    <label for="n">Candidate Name</label><input id="n" name="txtName" value="Ravi Kumar" />
    <label for="e">Email</label><input id="e" name="txtEmail" />
    <label for="s">State</label>
    <select id="s" name="ddlState">
      <option value="">Select</option>
      <option value="KA">Karnataka</option>
      <option value="TN">Tamil Nadu</option>
    </select>
  </form>
`;

const byId = (ref: string) => document.getElementById(ref);

beforeEach(() => {
  page(FORM);
  vi.useRealTimers();
});

describe('collecting what is really in the fields', () => {
  it('reads each requested ref', () => {
    expect(collectValues(['n', 'e'], byId)).toEqual({ n: 'Ravi Kumar', e: '' });
  });

  it('reads a select by value', () => {
    (byId('s') as HTMLSelectElement).value = 'TN';
    expect(collectValues(['s'], byId)).toEqual({ s: 'TN' });
  });

  it('reports a field that has gone as empty rather than omitting it', () => {
    // Omitting it would make the review silently drop a row; reporting it
    // empty makes the screen say "we cannot see this field".
    expect(collectValues(['n', 'gone'], byId)).toEqual({ n: 'Ravi Kumar', gone: '' });
  });

  it('asks for nothing it was not given', () => {
    expect(Object.keys(collectValues(['n'], byId))).toEqual(['n']);
  });
});

describe('pointing at a field', () => {
  it('marks it with our own element, never by restyling the page’s', () => {
    const input = byId('n') as HTMLInputElement;
    const before = input.outerHTML;

    focusField(input, document);

    expect(input.outerHTML).toBe(before);
    expect(document.getElementById('autofill-assistant-highlight')).not.toBeNull();
  });

  it('scrolls the field into view', () => {
    const input = byId('n') as HTMLInputElement;
    const scroll = vi.fn();
    input.scrollIntoView = scroll;

    focusField(input, document);

    expect(scroll).toHaveBeenCalled();
  });

  it('moves the caret there too, for anyone not following a coloured outline', () => {
    const input = byId('n') as HTMLInputElement;
    focusField(input, document);
    expect(document.activeElement).toBe(input);
  });

  it('cannot swallow the click of the user about to fix the value', () => {
    focusField(byId('n')!, document);
    const marker = document.getElementById('autofill-assistant-highlight')!;
    expect(marker.style.pointerEvents).toBe('none');
  });

  it('replaces the previous marker rather than stacking them up', () => {
    focusField(byId('n')!, document);
    focusField(byId('e')!, document);

    expect(document.querySelectorAll('#autofill-assistant-highlight')).toHaveLength(1);
  });

  it('cleans up after itself', () => {
    vi.useFakeTimers();
    focusField(byId('n')!, document);
    expect(document.getElementById('autofill-assistant-highlight')).not.toBeNull();

    vi.advanceTimersByTime(5_000);
    expect(document.getElementById('autofill-assistant-highlight')).toBeNull();
    vi.useRealTimers();
  });

  it('survives a field that cannot take focus', () => {
    page('<div id="d">not focusable</div>');
    expect(() => focusField(byId('d')!, document)).not.toThrow();
  });
});

describe('applying a correction', () => {
  it('writes the value and reads back what actually landed', () => {
    const outcome = applyEdit(byId('e')!, 'ravi@example.com');

    expect(outcome).toMatchObject({ ok: true, value: 'ravi@example.com' });
    expect((byId('e') as HTMLInputElement).value).toBe('ravi@example.com');
  });

  it('reports what the field kept, not what we sent', () => {
    // A maxLength keeps a prefix. The review must show the prefix, because
    // that is what the portal will receive.
    page('<input id="p" maxlength="6" />');
    const outcome = applyEdit(byId('p')!, '5600011234');

    expect(outcome.value).toBe('560001');
  });

  it('selects a dropdown option by its visible text', () => {
    const outcome = applyEdit(byId('s')!, 'Tamil Nadu');

    expect(outcome.ok).toBe(true);
    expect((byId('s') as HTMLSelectElement).value).toBe('TN');
  });

  it('fires the events a framework needs to notice the change', () => {
    const seen: string[] = [];
    const input = byId('e')!;
    for (const type of ['input', 'change']) {
      input.addEventListener(type, () => seen.push(type));
    }

    applyEdit(input, 'ravi@example.com');

    expect(seen).toEqual(expect.arrayContaining(['input', 'change']));
  });

  it('says so when the value will not go in', () => {
    const outcome = applyEdit(byId('s')!, 'Atlantis');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBeTruthy();
  });
});
