// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildSelectors,
  isXPath,
  labelAnchoredXPath,
  looksUnstable,
  looksUnstableName,
  structuralPath,
} from './selectors';

function mount(html: string): void {
  document.body.innerHTML = html;
}

function el(selector: string): Element {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`no element for ${selector}`);
  return node;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('looksUnstable', () => {
  it.each([
    'ctl00_ContentPlaceHolder1_txtName',
    'dnn_ctr445_ViewName_txt',
    'field-8f14e45fceea167a',
    'mui-4821',
    ':r3:',
    'input_17429',
  ])('rejects the generated id %s', (id) => {
    expect(looksUnstable(id)).toBe(true);
  });

  it.each(['txtFatherName', 'ddlState', 'applicant-dob', 'email', 'pincode1'])(
    'accepts the authored id %s',
    (id) => {
      expect(looksUnstable(id)).toBe(false);
    },
  );

  it('rejects an empty id', () => {
    expect(looksUnstable('')).toBe(true);
  });

  it('rejects ASP.NET names as unstable', () => {
    expect(looksUnstableName('ctl00$txtName')).toBe(true);
    expect(looksUnstableName('txtName')).toBe(false);
  });
});

describe('buildSelectors', () => {
  it('leads with a stable id', () => {
    mount('<form><input id="txtFName" name="txtFName"></form>');
    expect(buildSelectors(el('#txtFName'), 'Father Name', document)[0]).toBe('#txtFName');
  });

  it('skips a generated id and leads with the name', () => {
    mount('<form><input id="ctl00_txt_9f8e7d6c5b4a3210" name="fatherName"></form>');
    const selectors = buildSelectors(el('input'), 'Father Name', document);
    expect(selectors[0]).toBe('input[name="fatherName"]');
  });

  it('always ends with a structural path, so there is always something', () => {
    mount('<form><div><input></div></form>');
    const selectors = buildSelectors(el('input'), '', document);
    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors.at(-1)).toContain('input');
  });

  it('includes a label-anchored XPath when a label exists', () => {
    mount('<form><label for="a">Father Name</label><input id="a"></form>');
    const selectors = buildSelectors(el('#a'), 'Father Name', document);
    expect(selectors.some(isXPath)).toBe(true);
  });

  it('returns no duplicates', () => {
    mount('<form><input id="a" name="a"></form>');
    const selectors = buildSelectors(el('#a'), 'A', document);
    expect(new Set(selectors).size).toBe(selectors.length);
  });

  it('falls back to an unstable id when there is nothing better', () => {
    mount('<form><input id="ctl00_x_9f8e7d6c5b4a"></form>');
    const selectors = buildSelectors(el('input'), '', document);
    expect(selectors.some((s) => s.includes('ctl00'))).toBe(true);
  });

  it('escapes characters that break a CSS selector', () => {
    mount('<form><input id="ctl00" name="a$b:c"></form>');
    const selectors = buildSelectors(el('input'), '', document);
    const byName = selectors.find((s) => s.includes('name='));
    expect(byName).toContain('\\$');
  });
});

describe('structuralPath', () => {
  it('disambiguates siblings by nth-of-type', () => {
    mount('<form><input><input><input></form>');
    const inputs = [...document.querySelectorAll('input')];
    const paths = inputs.map((node) => structuralPath(node, document));
    expect(new Set(paths).size).toBe(3);
    expect(paths[1]).toContain('nth-of-type(2)');
  });

  it('omits nth-of-type for an only child', () => {
    mount('<form><div><input></div></form>');
    expect(structuralPath(el('input'), document)).not.toContain('nth-of-type');
  });

  it('anchors on a stable id ancestor and stops there', () => {
    mount('<div id="personal"><div><input></div></div>');
    const path = structuralPath(el('input'), document);
    expect(path.startsWith('#personal')).toBe(true);
  });

  it('resolves back to the original element', () => {
    mount('<form><div><span></span><input id="target"></div><div><input></div></form>');
    const path = structuralPath(el('#target'), document);
    expect(document.querySelector(path)).toBe(el('#target'));
  });
});

describe('labelAnchoredXPath', () => {
  it('anchors on a table cell in a table layout', () => {
    mount('<table><tr><td>Father Name</td><td><input id="a"></td></tr></table>');
    expect(labelAnchoredXPath(el('#a'), 'Father Name')).toContain('//td');
  });

  it('anchors on the label element when one points at the field', () => {
    mount('<label for="a">Father Name</label><input id="a">');
    expect(labelAnchoredXPath(el('#a'), 'Father Name')).toContain('//label');
  });

  it('refuses text that is too short, too long, or contains a quote', () => {
    mount('<input id="a">');
    expect(labelAnchoredXPath(el('#a'), 'X')).toBeNull();
    expect(labelAnchoredXPath(el('#a'), 'y'.repeat(80))).toBeNull();
    expect(labelAnchoredXPath(el('#a'), 'He said "hi"')).toBeNull();
  });
});

describe('isXPath', () => {
  it('distinguishes XPath from CSS', () => {
    expect(isXPath('//label[text()="X"]/following::input[1]')).toBe(true);
    expect(isXPath('#txtName')).toBe(false);
    expect(isXPath('input[name="a"]')).toBe(false);
  });
});
