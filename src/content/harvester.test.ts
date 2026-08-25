// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { detectWizard, findFrameBlockers, harvest, isVisible } from './harvester';

function mount(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('field enumeration', () => {
  it('captures inputs, selects, and textareas', () => {
    mount(`
      <label for="a">Name</label><input id="a">
      <label for="b">State</label><select id="b"><option value="KA">Karnataka</option></select>
      <label for="c">Address</label><textarea id="c"></textarea>
    `);
    const { fields } = harvest(document);
    expect(fields.map((f) => f.tag)).toEqual(['input', 'select', 'textarea']);
    expect(fields.map((f) => f.labelText)).toEqual(['Name', 'State', 'Address']);
  });

  it('assigns refs in document order and resolves them back to elements', () => {
    mount('<input id="a"><input id="b"><input id="c">');
    const { fields, elements } = harvest(document);
    expect(fields.map((f) => f.ref)).toEqual(['f0', 'f1', 'f2']);
    expect(elements.get('f1')?.getAttribute('id')).toBe('b');
  });

  it('skips buttons, submits, and hidden inputs', () => {
    mount(`
      <input id="a"><input type="submit" value="Go"><input type="button" value="X">
      <input type="hidden" name="__VIEWSTATE" value="abc"><input type="reset">
    `);
    expect(harvest(document).fields).toHaveLength(1);
  });

  it('never harvests a password field', () => {
    mount('<label for="p">Password</label><input id="p" type="password">');
    expect(harvest(document).fields).toHaveLength(0);
  });

  it('collapses a radio group into one field carrying its options', () => {
    mount(`
      <fieldset><legend>Gender</legend>
        <label><input type="radio" name="gender" value="M"> Male</label>
        <label><input type="radio" name="gender" value="F"> Female</label>
        <label><input type="radio" name="gender" value="T"> Transgender</label>
      </fieldset>
    `);
    const { fields } = harvest(document);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.tag).toBe('radio-group');
    expect(fields[0]?.options?.map((o) => o.value)).toEqual(['M', 'F', 'T']);
    expect(fields[0]?.options?.map((o) => o.text)).toEqual(['Male', 'Female', 'Transgender']);
  });

  it('keeps separate radio groups separate', () => {
    mount(`
      <input type="radio" name="gender" value="M"><input type="radio" name="gender" value="F">
      <input type="radio" name="category" value="GEN"><input type="radio" name="category" value="OBC">
    `);
    expect(harvest(document).fields).toHaveLength(2);
  });

  it('captures select options', () => {
    mount(`<select id="s">
      <option value="">-- Select --</option>
      <option value="KA">Karnataka</option>
      <option value="MH">Maharashtra</option>
    </select>`);
    const { fields } = harvest(document);
    expect(fields[0]?.options).toEqual([
      { value: '', text: '-- Select --' },
      { value: 'KA', text: 'Karnataka' },
      { value: 'MH', text: 'Maharashtra' },
    ]);
  });

  it('records maxLength, pattern, and type', () => {
    mount('<input id="a" type="tel" maxlength="10" pattern="[0-9]{10}">');
    const field = harvest(document).fields[0];
    expect(field).toMatchObject({ type: 'tel', maxLength: 10, pattern: '[0-9]{10}' });
  });

  it('honours the field cap', () => {
    mount('<input>'.repeat(50));
    expect(harvest(document, { maxFields: 10 }).fields).toHaveLength(10);
  });
});

describe('required detection', () => {
  it('reads the required attribute', () => {
    mount('<input id="a" required>');
    expect(harvest(document).fields[0]?.required).toBe(true);
  });

  it('reads aria-required', () => {
    mount('<input id="a" aria-required="true">');
    expect(harvest(document).fields[0]?.required).toBe(true);
  });

  it('reads an asterisk in the surrounding cell, as portals actually mark it', () => {
    mount('<table><tr><td>Name *</td><td><input id="a"></td></tr></table>');
    expect(harvest(document).fields[0]?.required).toBe(true);
  });

  it('leaves optional fields alone', () => {
    mount('<div><label for="a">Middle Name</label><input id="a"></div>');
    expect(harvest(document).fields[0]?.required).toBe(false);
  });
});

describe('enabled and visible', () => {
  it('marks disabled controls', () => {
    mount('<input id="a" disabled>');
    expect(harvest(document).fields[0]?.enabled).toBe(false);
  });

  it('marks readonly controls as not enabled', () => {
    mount('<input id="a" readonly>');
    expect(harvest(document).fields[0]?.enabled).toBe(false);
  });

  it('marks display:none controls as not visible', () => {
    mount('<div style="display:none"><input id="a"></div>');
    expect(harvest(document).fields[0]?.visible).toBe(false);
  });

  it('marks visibility:hidden controls as not visible', () => {
    mount('<input id="a" style="visibility:hidden">');
    expect(isVisible(document.querySelector('#a')!)).toBe(false);
  });

  it('respects the hidden attribute and aria-hidden', () => {
    mount('<input id="a" hidden><input id="b" aria-hidden="true">');
    const { fields } = harvest(document);
    expect(fields.every((f) => !f.visible)).toBe(true);
  });

  it('still reports hidden fields rather than dropping them', () => {
    // A hidden-but-present field may become visible after a postback; dropping
    // it here would make Phase 6's REVERIFYING think the form changed shape.
    mount('<div style="display:none"><input id="a"></div><input id="b">');
    expect(harvest(document).fields).toHaveLength(2);
  });
});

describe('security fields are reported, never harvested (P4)', () => {
  it.each([
    ['<input id="txtCaptcha" name="captcha">', 'captcha'],
    ['<input id="otpInput" name="otp">', 'otp'],
    ['<input name="verificationCode">', 'otp'],
  ])('reports %s as a blocker', (html, type) => {
    mount(html);
    const { fields, blockers } = harvest(document);
    expect(fields).toHaveLength(0);
    expect(blockers[0]?.type).toBe(type);
  });

  it('does not mistake an ordinary field for a security one', () => {
    mount('<input name="optionalRemarks"><input name="notifyEmail">');
    expect(harvest(document).blockers).toHaveLength(0);
  });
});

describe('cross-origin frames', () => {
  it('reports an unreadable frame rather than skipping it', () => {
    mount('<iframe src="https://payments.example.com/widget"></iframe>');
    const blockers = findFrameBlockers(document);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.type).toBe('unknown_widget');
    expect(blockers[0]?.reason).toContain('payments.example.com');
  });

  it('recognises a reCAPTCHA frame specifically', () => {
    mount('<iframe src="https://www.google.com/recaptcha/api2/anchor" title="reCAPTCHA"></iframe>');
    const blockers = findFrameBlockers(document);
    expect(blockers[0]?.type).toBe('captcha');
    expect(blockers[0]?.reason).toMatch(/complete it yourself/i);
  });

  it('surfaces frame blockers through harvest', () => {
    mount('<input id="a"><iframe src="https://other.example.com/x"></iframe>');
    const { fields, blockers } = harvest(document);
    expect(fields).toHaveLength(1);
    expect(blockers).toHaveLength(1);
  });
});

describe('shadow DOM', () => {
  it('pierces an open shadow root', () => {
    mount('<div id="host"></div>');
    const host = document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<label for="s">Shadow Field</label><input id="s">';

    const { fields } = harvest(document, { shadowDom: true });
    expect(fields.map((f) => f.labelText)).toContain('Shadow Field');
  });

  it('can be turned off', () => {
    mount('<div id="host"></div>');
    const shadow = document.querySelector('#host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="s">';
    expect(harvest(document, { shadowDom: false }).fields).toHaveLength(0);
  });
});

describe('wizard detection', () => {
  it('reads an explicit "Step 2 of 5" indicator', () => {
    mount('<div class="wizard-steps">Step 2 of 5</div><input>');
    expect(detectWizard(document)).toMatchObject({ step: 2, totalSteps: 5 });
  });

  it('reads a "Page 3 / 4" indicator', () => {
    mount('<div class="progress">Page 3 / 4</div>');
    expect(detectWizard(document)).toMatchObject({ step: 3, totalSteps: 4 });
  });

  it('falls back to the active item in a step list', () => {
    mount(`<ul class="steps">
      <li class="step done">Personal</li>
      <li class="step active">Education</li>
      <li class="step">Documents</li>
    </ul>`);
    expect(detectWizard(document)).toMatchObject({ step: 2, totalSteps: 3 });
  });

  it('reads the step out of a heading, which is often the only place it is', () => {
    // Found via the Phase 6 postback fixture: the step was announced in the
    // <h1> and nowhere else, so the detector fell through to the weak
    // "there is a Next button" branch and reported no step number at all.
    mount('<h1>Scholarship Application — Step 2 of 3</h1><form><input></form>');
    expect(detectWizard(document)).toMatchObject({ step: 2, totalSteps: 3 });
  });

  it('prefers a real step count over the mere presence of a Next button', () => {
    mount(`
      <h1>Application — Step 2 of 3</h1>
      <form><input><button type="submit">Save &amp; Continue</button></form>
    `);
    expect(detectWizard(document)).toMatchObject({ step: 2, totalSteps: 3 });
  });

  it('infers a multi-step form from a Next button alone', () => {
    mount('<form><input><button type="submit">Next</button></form>');
    const wizard = detectWizard(document);
    expect(wizard?.step).toBeNull();
    expect(wizard?.evidence).toBe('Next');
  });

  it('returns null for an ordinary single-page form', () => {
    mount('<form><input><button type="submit">Final Submit</button></form>');
    expect(detectWizard(document)).toBeNull();
  });
});

describe('label sources are reported for the review screen', () => {
  it('records which rule produced each label', () => {
    mount(`
      <label for="a">Name</label><input id="a">
      <table><tr><td>Father's Name</td><td><input id="b"></td></tr></table>
    `);
    const { labelSources } = harvest(document);
    expect(labelSources.get('f0')).toBe('label-for');
    expect(labelSources.get('f1')).toBe('table-cell');
  });
});

describe('read-only guarantee', () => {
  it('leaves the DOM byte-identical', () => {
    mount(`
      <form action="/apply"><table><tr><td>Name *</td><td><input id="a" required></td></tr></table>
      <select id="b"><option>One</option></select>
      <iframe src="https://x.example.com/f"></iframe></form>
    `);
    const before = document.body.innerHTML;
    harvest(document);
    expect(document.body.innerHTML).toBe(before);
  });
});
