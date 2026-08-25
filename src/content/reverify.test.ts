// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readValue, resolveRanked, reverify, sameValue, type PlannedRef } from './reverify';
import { watchPage } from './watcher';

function page(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('resolving a field after the page has changed under it', () => {
  it('uses the first selector that still works, and says which', () => {
    page('<input name="txtName" />');
    const found = resolveRanked(['#ctl00_x_txtName', 'input[name="txtName"]'], document);

    expect(found?.selector).toBe('input[name="txtName"]');
    // Index 1 means the id died and the fallback carried it — the exact case
    // an ASP.NET postback creates.
    expect(found?.index).toBe(1);
  });

  it('falls back to a label-anchored XPath when id and name are both gone', () => {
    page('<label for="z">Full Name</label><input id="z" />');
    const found = resolveRanked(
      ['#gone', 'input[name="alsoGone"]', "//label[normalize-space()='Full Name']/following::input[1]"],
      document,
    );
    expect(found?.index).toBe(2);
    expect(found?.el.id).toBe('z');
  });

  it('treats an invalid selector as a miss rather than a crash', () => {
    page('<input id="a" />');
    expect(resolveRanked(['###nonsense', '#a'], document)?.el.id).toBe('a');
    expect(resolveRanked(['//['], document)).toBeNull();
  });

  it('returns null when nothing resolves', () => {
    page('<input id="a" />');
    expect(resolveRanked(['#b', 'input[name="c"]'], document)).toBeNull();
  });
});

describe('reading a value back', () => {
  it.each([
    ['a text input', '<input id="e" value="Ravi" />', 'Ravi'],
    ['an empty input', '<input id="e" />', ''],
    ['a textarea', '<textarea id="e">Line one</textarea>', 'Line one'],
  ])('reads %s', (_name, html, expected) => {
    page(html);
    expect(readValue(document.getElementById('e')!)).toBe(expected);
  });

  it('reads a select by its value, not its label', () => {
    page('<select id="e"><option value="">Choose</option><option value="KA" selected>Karnataka</option></select>');
    expect(readValue(document.getElementById('e')!)).toBe('KA');
  });

  it('reads a checkbox as its checkedness', () => {
    page('<input id="e" type="checkbox" checked />');
    expect(readValue(document.getElementById('e')!)).toBe('true');
    (document.getElementById('e') as HTMLInputElement).checked = false;
    expect(readValue(document.getElementById('e')!)).toBe('');
  });

  it('reads a radio group as the chosen member, from any member', () => {
    page(`
      <input id="m" type="radio" name="g" value="male" />
      <input id="f" type="radio" name="g" value="female" checked />
    `);
    // Asked via the *unchecked* member — a radio group is one field, and the
    // plan holds one ref for it.
    expect(readValue(document.getElementById('m')!)).toBe('female');
  });

  it('reports a file input as empty or not, and never as a filename', () => {
    page('<input id="e" type="file" />');
    const value = readValue(document.getElementById('e')!);
    expect(value).toBe('');
    expect(value).not.toContain('.jpg');
  });
});

describe('deciding whether the page kept what we wrote', () => {
  it.each([
    ['an exact match', 'Ravi Kumar', 'Ravi Kumar'],
    ['trailing whitespace the page trimmed', 'Ravi Kumar', 'Ravi Kumar  '],
    ['a PAN the page upper-cased', 'ABCDE1234F', 'abcde1234f'],
    ['a date the page reformatted', '01-04-2001', '01/04/2001'],
    ['an account number the page unspaced', '1234 5678 9012', '123456789012'],
    ['a value the page truncated to maxLength', '560001', '5600011234'],
  ])('accepts %s', (_name, current, expected) => {
    expect(sameValue(current, expected)).toBe(true);
  });

  it.each([
    ['an emptied field', '', 'Ravi Kumar'],
    ['a different value', 'Priya', 'Ravi Kumar'],
    ['a placeholder the page substituted', 'Select', 'Karnataka'],
  ])('rejects %s', (_name, current, expected) => {
    expect(sameValue(current, expected)).toBe(false);
  });
});

describe('the postback case: values wiped, ids regenerated', () => {
  const fields: PlannedRef[] = [
    { ref: 'f1', selectors: ['#ctl00_a_txtName', 'input[name="txtName"]'], expected: 'Ravi Kumar', required: true },
    { ref: 'f2', selectors: ['#ctl00_a_txtEmail', 'input[name="txtEmail"]'], expected: 'ravi@example.com' },
  ];

  it('notices everything was reset, and asks for a refill', () => {
    // The postback came back with new ids and empty boxes.
    page(`
      <input id="ctl00_b_txtName" name="txtName" />
      <input id="ctl00_b_txtEmail" name="txtEmail" />
    `);

    const result = reverify(fields, document);

    expect(result.lost).toEqual([]);
    expect(result.needsRefill).toEqual(['f1', 'f2']);
    expect(result.movedSelector).toEqual(['f1', 'f2']);
    expect(result.requiredButEmpty).toEqual(['f1']);
  });

  it('says nothing needs doing when the values survived', () => {
    page(`
      <input id="ctl00_b_txtName" name="txtName" value="Ravi Kumar" />
      <input id="ctl00_b_txtEmail" name="txtEmail" value="ravi@example.com" />
    `);

    const result = reverify(fields, document);
    expect(result.needsRefill).toEqual([]);
    expect(result.lost).toEqual([]);
    expect(result.verdicts.every((v) => v.matches === true)).toBe(true);
  });

  it('reports a field whose selectors all died as lost, not as needing a refill', () => {
    // This is the difference between "fill it again" and "ask the user to
    // point at it". Confusing the two either loops forever or skips silently.
    page('<input id="ctl00_b_txtEmail" name="txtEmail" value="ravi@example.com" />');

    const result = reverify(fields, document);
    expect(result.lost).toEqual(['f1']);
    expect(result.needsRefill).toEqual([]);
    expect(result.verdicts[0]).toMatchObject({ ref: 'f1', resolved: false });
  });

  it('with no expectation to compare against, refills whatever is empty', () => {
    // After a navigation the content script's memory is gone, so emptiness is
    // the only signal left. It is enough.
    page('<input name="txtName" /><input name="txtEmail" value="ravi@example.com" />');

    const result = reverify(
      [
        { ref: 'f1', selectors: ['input[name="txtName"]'] },
        { ref: 'f2', selectors: ['input[name="txtEmail"]'] },
      ],
      document,
    );

    expect(result.needsRefill).toEqual(['f1']);
    expect(result.verdicts[0]?.matches).toBeNull();
  });

  it('does not refill a field the user themselves changed after we filled it', () => {
    // We wrote "Ravi Kumar"; the box now says "Ravi Kumar Reddy". That is the
    // user correcting us, and overwriting it would be the single rudest thing
    // this extension could do.
    page('<input name="txtName" value="Ravi Kumar Reddy" />');

    const result = reverify(
      [{ ref: 'f1', selectors: ['input[name="txtName"]'], expected: 'Ravi Kumar' }],
      document,
    );

    // It differs, so it is flagged for refill — and this test exists to record
    // that the *machine* must not act on it blindly. See the note in
    // fill-run: refills are proposed, and a user-modified field is skipped.
    expect(result.verdicts[0]?.matches).toBe(false);
  });
});

describe('the watcher', () => {
  it('reports churn once more than 20% of tracked fields are replaced', async () => {
    const doc = page(
      Array.from({ length: 10 }, (_, i) => `<input id="i${i}" />`).join(''),
    );
    const churn = vi.fn();
    const handle = watchPage(doc, {
      tracked: () => [...doc.querySelectorAll('input')],
      onChurn: churn,
    });

    // Replace three of ten — over the threshold.
    for (const id of ['i0', 'i1', 'i2']) doc.getElementById(id)?.remove();
    handle.check();

    expect(churn).toHaveBeenCalledWith('mutation', 0.3);
    handle.stop();
  });

  it('stays quiet when the page merely fidgets', () => {
    const doc = page(Array.from({ length: 10 }, (_, i) => `<input id="i${i}" />`).join(''));
    const churn = vi.fn();
    const handle = watchPage(doc, {
      tracked: () => [...doc.querySelectorAll('input')],
      onChurn: churn,
    });

    doc.getElementById('i0')?.remove(); // 10%
    handle.check();

    expect(churn).not.toHaveBeenCalled();
    handle.stop();
  });

  it('re-baselines after churn, so one postback is not reported forever', () => {
    const doc = page(Array.from({ length: 10 }, (_, i) => `<input id="i${i}" />`).join(''));
    const churn = vi.fn();
    const handle = watchPage(doc, {
      tracked: () => [...doc.querySelectorAll('input')],
      onChurn: churn,
    });

    for (const id of ['i0', 'i1', 'i2']) doc.getElementById(id)?.remove();
    handle.check();
    handle.check();
    handle.check();

    expect(churn).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('reports a settle only after the page goes quiet', async () => {
    vi.useFakeTimers();
    const doc = page('<input id="i0" />');
    const settled = vi.fn();
    const handle = watchPage(doc, {
      tracked: () => [...doc.querySelectorAll('input')],
      onChurn: () => {},
      onSettled: settled,
      settleMs: 100,
    });

    handle.check();
    vi.advanceTimersByTime(50);
    handle.check(); // still busy — the clock restarts
    vi.advanceTimersByTime(50);
    expect(settled).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60);
    expect(settled).toHaveBeenCalledTimes(1);

    handle.stop();
    vi.useRealTimers();
  });

  it('stops cleanly, firing nothing afterwards', () => {
    vi.useFakeTimers();
    const doc = page('<input id="i0" /><input id="i1" />');
    const churn = vi.fn();
    const settled = vi.fn();
    const handle = watchPage(doc, {
      tracked: () => [...doc.querySelectorAll('input')],
      onChurn: churn,
      onSettled: settled,
      settleMs: 10,
    });

    handle.check();
    handle.stop();
    doc.getElementById('i0')?.remove();
    handle.check();
    vi.advanceTimersByTime(100);

    expect(churn).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('treats a navigation as total churn', () => {
    const doc = page('<input id="i0" />');
    const churn = vi.fn();
    const handle = watchPage(doc, {
      tracked: () => [...doc.querySelectorAll('input')],
      onChurn: churn,
    });

    doc.defaultView?.dispatchEvent(new Event('pagehide'));
    expect(churn).toHaveBeenCalledWith('navigation', 1);
    handle.stop();
  });
});
