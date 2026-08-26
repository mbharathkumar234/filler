// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { describeElement, startPicker, type PickedElement } from './picker';

/**
 * The picker.
 *
 * Most of these tests are about the picker *not letting the page win*. A
 * portal is full of things that act on a click — labels that focus, anchors
 * that navigate, forms that submit — and a picker that lets one through would
 * take the user off a form they have already filled. That is worse than having
 * no picker.
 */

const FORM = `
  <form id="frm" action="/next">
    <label for="n">Candidate Name</label><input id="n" name="txtName" />
    <label for="e">Email</label><input id="e" name="txtEmail" type="email" />
    <label for="p">Password</label><input id="p" name="pwd" type="password" />
    <input id="h" type="hidden" name="__VIEWSTATE" />
    <a id="link" href="/elsewhere">A link</a>
    <button id="go" type="submit">Continue</button>
  </form>
`;

function page(html = FORM): Document {
  document.body.innerHTML = html;
  return document;
}

beforeEach(() => {
  page();
});

function picked(id: string): PickedElement {
  return describeElement(document.getElementById(id)!, document);
}

describe('describing what was clicked', () => {
  it('records ranked selectors and the label the user sees', () => {
    const result = picked('n');

    expect(result.selectors[0]).toBe('#n');
    expect(result.selectors).toContain('input[name="txtName"]');
    expect(result.label).toBe('Candidate Name');
    expect(result.refused).toBeUndefined();
  });

  it('still names a field the page never labelled', () => {
    // Phase 3's last-resort label rule already turns `txtMystery` into
    // "Mystery", so the picker's own fallback rarely fires — what matters is
    // that the user is shown something they can recognise either way.
    page('<input id="x" name="txtMystery" />');
    expect(picked('x').label).toBe('Mystery');
  });

  it('falls back to the tag and name when even that finds nothing', () => {
    page('<textarea id="x"></textarea>');
    const label = picked('x').label;
    expect(label).toContain('textarea');
    expect(label).not.toBe('');
  });

  it('ties the pick back to a field we already knew about', () => {
    const result = describeElement(document.getElementById('n')!, document, {
      known: [
        {
          ref: 'f0',
          selectors: ['#n'],
          tag: 'input',
          labelText: 'Candidate Name',
          nearbyText: '',
          required: false,
          frameId: 0,
          visible: true,
          enabled: true,
        },
      ],
      resolve: (ref) => (ref === 'f0' ? document.getElementById('n') : null),
    });

    expect(result.ref).toBe('f0');
  });
});

describe('what cannot be taught, and why', () => {
  it.each([
    ['a link', 'link', /not a form field/i],
    ['a password box', 'p', /never filled/i],
    ['a hidden input', 'h', /hidden/i],
  ])('refuses %s with a reason', (_name, id, expected) => {
    const result = picked(id);
    expect(result.refused).toMatch(expected);
  });

  it('refuses a CAPTCHA answer box — there is no key to teach it to', () => {
    // P4. Not silently ignored: a user who clicks and gets nothing clicks again.
    page(`
      <img id="imgCaptcha" alt="captcha" src="/captcha.png" />
      <input id="cap" name="txtCaptcha" />
    `);
    expect(picked('cap').refused).toMatch(/security field/i);
  });

  it('refuses a one-time-code box for the same reason', () => {
    page('<input id="otp" name="txtOTP" /><input id="other" name="txtName" />');
    expect(picked('otp').refused).toMatch(/security field/i);
  });

  it('still allows an ordinary field on a page that has a CAPTCHA', () => {
    // The blocker is on the page, not on this element. Refusing everything
    // would make teach mode useless on exactly the portals that need it.
    page(`
      <div class="g-recaptcha" data-sitekey="x"></div>
      <label for="n">Candidate Name</label><input id="n" name="txtName" />
    `);
    expect(picked('n').refused).toBeUndefined();
  });
});

describe('the page does not get the click', () => {
  it('swallows the click instead of letting the form navigate', () => {
    const doc = page();
    const onClick = vi.fn();
    doc.getElementById('go')!.addEventListener('click', onClick);

    const handle = startPicker(doc, { onPick: () => {} });
    doc.getElementById('go')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onClick).not.toHaveBeenCalled();
    handle.stop();
  });

  it('swallows pointerdown too — some frameworks never wait for the click', () => {
    const doc = page();
    const onDown = vi.fn();
    doc.getElementById('n')!.addEventListener('pointerdown', onDown);

    const handle = startPicker(doc, { onPick: () => {} });
    doc.getElementById('n')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    expect(onDown).not.toHaveBeenCalled();
    handle.stop();
  });

  it('reports the picked field to the caller', () => {
    const doc = page();
    const onPick = vi.fn();
    const handle = startPicker(doc, { onPick });

    doc.getElementById('n')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatchObject({ label: 'Candidate Name' });
    handle.stop();
  });

  it('walks up from a label to the field it belongs to', () => {
    // Users point at the words, not at the box.
    const doc = page('<label id="lbl" for="n">Candidate Name <input id="n" name="txtName" /></label>');
    const onPick = vi.fn();
    const handle = startPicker(doc, { onPick });

    doc.getElementById('n')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onPick.mock.calls[0]![0].tag).toBe('input');
    handle.stop();
  });

  it('ignores clicks on its own overlay', () => {
    const doc = page();
    const onPick = vi.fn();
    const handle = startPicker(doc, { onPick });

    doc.getElementById('autofill-assistant-picker')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );

    expect(onPick).not.toHaveBeenCalled();
    handle.stop();
  });
});

describe('getting out', () => {
  it('cancels on Escape', () => {
    const doc = page();
    const onCancel = vi.fn();
    const handle = startPicker(doc, { onPick: () => {}, onCancel });

    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onCancel).toHaveBeenCalled();
    expect(doc.getElementById('autofill-assistant-picker')).toBeNull();
    handle.stop();
  });

  it('gives the page its clicks back when it stops', () => {
    const doc = page();
    const onClick = vi.fn();
    doc.getElementById('go')!.addEventListener('click', onClick);

    startPicker(doc, { onPick: () => {} }).stop();
    doc.getElementById('go')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onClick).toHaveBeenCalled();
  });

  it('picks nothing after it has stopped', () => {
    const doc = page();
    const onPick = vi.fn();
    const handle = startPicker(doc, { onPick });
    handle.stop();

    handle.pick(doc.getElementById('n')!);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('removes its overlay, leaving the page as it found it', () => {
    const doc = page();
    const before = doc.getElementById('frm')!.outerHTML;

    const handle = startPicker(doc, { onPick: () => {} });
    handle.stop();

    expect(doc.getElementById('autofill-assistant-picker')).toBeNull();
    expect(doc.getElementById('frm')!.outerHTML).toBe(before);
  });

  it('replaces an earlier overlay rather than stacking them', () => {
    const doc = page();
    const first = startPicker(doc, { onPick: () => {} });
    const second = startPicker(doc, { onPick: () => {} });

    expect(doc.querySelectorAll('#autofill-assistant-picker')).toHaveLength(1);
    first.stop();
    second.stop();
  });
});
