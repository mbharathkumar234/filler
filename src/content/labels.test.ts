// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanLabel, humaniseIdentifier, resolveLabel, resolveNearbyText } from './labels';

/**
 * Every case here is a real portal markup pattern. The plan names five of them
 * explicitly (§ Phase 3) because they are the ones that break naive harvesters:
 * table layouts, `<label>` without `for`, floating labels, `aria-labelledby`,
 * and bare text nodes.
 */
function mount(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

function field(selector = 'input'): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('label[for]', () => {
  it('resolves the standard case', () => {
    mount('<label for="a">Candidate Name</label><input id="a">');
    expect(resolveLabel(field())).toEqual({ text: 'Candidate Name', source: 'label-for' });
  });

  it('strips the required-field asterisk and trailing colon', () => {
    mount('<label for="a">Mobile Number* :</label><input id="a">');
    expect(resolveLabel(field()).text).toBe('Mobile Number');
  });

  it('wins over a placeholder', () => {
    mount('<label for="a">Email ID</label><input id="a" placeholder="you@example.com">');
    expect(resolveLabel(field()).text).toBe('Email ID');
  });
});

describe('wrapping label', () => {
  it('resolves a label that contains the input', () => {
    mount('<label>Date of Birth <input type="date"></label>');
    expect(resolveLabel(field())).toEqual({ text: 'Date of Birth', source: 'label-wrapping' });
  });

  it('does not absorb the input’s own value', () => {
    mount('<label>Gender <select><option>Male</option><option>Female</option></select></label>');
    expect(resolveLabel(field('select')).text).toBe('Gender');
  });
});

describe('aria', () => {
  it('resolves aria-labelledby across several ids', () => {
    mount('<span id="s1">Permanent</span><span id="s2">Address</span><input aria-labelledby="s1 s2">');
    expect(resolveLabel(field())).toEqual({ text: 'Permanent Address', source: 'aria-labelledby' });
  });

  it('falls back to aria-label', () => {
    mount('<input aria-label="PIN Code">');
    expect(resolveLabel(field())).toEqual({ text: 'PIN Code', source: 'aria-label' });
  });

  it('prefers aria-labelledby over aria-label', () => {
    mount('<span id="s">District</span><input aria-labelledby="s" aria-label="Other">');
    expect(resolveLabel(field()).text).toBe('District');
  });

  it('ignores aria-labelledby pointing at a missing id', () => {
    mount('<input aria-labelledby="nope" placeholder="Village">');
    expect(resolveLabel(field()).source).toBe('placeholder');
  });
});

describe('table layouts — the ASP.NET classic', () => {
  it('reads the cell to the left', () => {
    mount(`<table><tr>
      <td>पिता का नाम / Father's Name</td>
      <td><input id="txtFName"></td>
    </tr></table>`);
    const resolved = resolveLabel(field('#txtFName'));
    expect(resolved.source).toBe('table-cell');
    expect(resolved.text).toContain("Father's Name");
  });

  it('skips empty spacer cells to the left', () => {
    mount(`<table><tr>
      <td>Annual Income</td><td></td><td>&nbsp;</td>
      <td><input id="txtIncome"></td>
    </tr></table>`);
    expect(resolveLabel(field('#txtIncome')).text).toBe('Annual Income');
  });

  it('falls back to the header cell above in a grid', () => {
    mount(`<table>
      <tr><th>Roll Number</th><th>Year</th></tr>
      <tr><td><input id="r"></td><td><input id="y"></td></tr>
    </table>`);
    expect(resolveLabel(field('#r')).text).toBe('Roll Number');
    expect(resolveLabel(field('#y')).text).toBe('Year');
  });

  it('does not read a neighbouring input’s cell as the label', () => {
    mount(`<table><tr>
      <td>City</td><td><input id="city"></td>
      <td><input id="pin"></td>
    </tr></table>`);
    // The cell left of #pin holds a control, not label text.
    expect(resolveLabel(field('#pin')).text).not.toBe('City');
  });
});

describe('floating and sibling labels', () => {
  it('resolves a label that follows the input', () => {
    mount('<div class="field"><input id="a"><label for="a">Full Name</label></div>');
    // label[for] still wins, which is correct.
    expect(resolveLabel(field('#a')).source).toBe('label-for');
  });

  it('resolves a following label with no for attribute', () => {
    mount('<div class="field"><input><label>Aadhaar Number</label></div>');
    expect(resolveLabel(field())).toEqual({ text: 'Aadhaar Number', source: 'sibling-label' });
  });

  it('looks one level up when the wrapper holds a single control', () => {
    mount('<div class="group"><label>Bank Name</label><div class="ctrl"><input></div></div>');
    expect(resolveLabel(field()).text).toBe('Bank Name');
  });

  it('refuses to guess when a wrapper holds several controls', () => {
    mount(`<div class="group"><label>Address</label>
      <div class="ctrl"><input id="l1"><input id="l2"></div></div>`);
    expect(resolveLabel(field('#l2')).source).not.toBe('sibling-label');
  });
});

describe('preceding text nodes', () => {
  it('reads a bare text node before the input', () => {
    mount('<div>Marks Obtained <input id="m"></div>');
    expect(resolveLabel(field('#m'))).toEqual({ text: 'Marks Obtained', source: 'preceding-text' });
  });

  it('reads a preceding span', () => {
    mount('<div><span>Blood Group</span><input></div>');
    expect(resolveLabel(field()).text).toBe('Blood Group');
  });

  it('stops at the previous control rather than absorbing its label', () => {
    mount('<div>City <input id="city"> State <input id="state"></div>');
    expect(resolveLabel(field('#state')).text).toBe('State');
  });

  it('ignores punctuation-only text', () => {
    mount('<div>: <input placeholder="IFSC"></div>');
    expect(resolveLabel(field()).source).toBe('placeholder');
  });
});

describe('last resorts', () => {
  it('uses the placeholder', () => {
    mount('<input placeholder="Enter your PAN">');
    expect(resolveLabel(field())).toEqual({ text: 'Enter your PAN', source: 'placeholder' });
  });

  it('uses the title attribute', () => {
    mount('<input title="Branch Name">');
    expect(resolveLabel(field()).source).toBe('title');
  });

  it('humanises the name attribute when nothing else exists', () => {
    mount('<input name="txtFatherName">');
    expect(resolveLabel(field())).toEqual({ text: 'Father Name', source: 'name-attribute' });
  });

  it('reports none when there is genuinely nothing', () => {
    mount('<input>');
    expect(resolveLabel(field())).toEqual({ text: '', source: 'none' });
  });
});

describe('humaniseIdentifier', () => {
  it.each([
    ['txtFatherName', 'Father Name'],
    ['ddlState', 'State'],
    ['hdnPan', 'Pan'],
    ['applicant_dob', 'Applicant dob'],
    ['fuPhoto', 'Photo'],
  ])('turns %s into %s', (input, want) => {
    expect(humaniseIdentifier(input)).toBe(want);
  });

  it('returns empty for something with no signal', () => {
    expect(humaniseIdentifier('x')).toBe('');
  });
});

describe('cleanLabel', () => {
  it('collapses whitespace and trims decorations', () => {
    expect(cleanLabel('  Father  Name * : ')).toBe('Father Name');
  });

  it('caps very long text', () => {
    expect(cleanLabel('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });

  it('handles null and undefined', () => {
    expect(cleanLabel(null)).toBe('');
    expect(cleanLabel(undefined)).toBe('');
  });
});

describe('resolveNearbyText', () => {
  it('finds the preceding section heading', () => {
    mount('<h2>Permanent Address</h2><div><label for="a">Line 1</label><input id="a"></div>');
    expect(resolveNearbyText(field('#a'))).toBe('Permanent Address');
  });

  it('includes a fieldset legend', () => {
    mount('<fieldset><legend>Bank Details</legend><input id="a"></fieldset>');
    expect(resolveNearbyText(field('#a'))).toBe('Bank Details');
  });

  it('distinguishes two identically-labelled address blocks', () => {
    mount(`
      <h3>Permanent Address</h3><div><input id="p1" placeholder="Line 1"></div>
      <h3>Correspondence Address</h3><div><input id="c1" placeholder="Line 1"></div>
    `);
    expect(resolveNearbyText(field('#p1'))).toBe('Permanent Address');
    expect(resolveNearbyText(field('#c1'))).toBe('Correspondence Address');
  });

  it('returns empty when there is no section context', () => {
    mount('<input id="a">');
    expect(resolveNearbyText(field('#a'))).toBe('');
  });
});
