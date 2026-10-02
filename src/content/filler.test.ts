// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fillCheckbox,
  fillElement,
  fillRadioGroup,
  fillSelect,
  fillText,
  findOption,
  restore,
  setNativeValue,
  snapshot,
} from './filler';

function mount(html: string): void {
  document.body.innerHTML = html;
}

function el<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no element for ${selector}`);
  return node;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('setNativeValue', () => {
  it('writes a value', () => {
    mount('<input id="a">');
    setNativeValue(el<HTMLInputElement>('#a'), 'Ravi Kumar');
    expect(el<HTMLInputElement>('#a').value).toBe('Ravi Kumar');
  });

  it('bypasses an instance-level setter, as React installs', () => {
    mount('<input id="a">');
    const input = el<HTMLInputElement>('#a');

    // Simulate React's value tracker: an own property that swallows writes.
    let tracked = '';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => tracked,
      set: (v: string) => {
        tracked = `SWALLOWED:${v}`;
      },
    });

    setNativeValue(input, 'Ravi Kumar');

    // The prototype setter was used, so the tracker did not intercept it.
    expect(tracked).not.toBe('SWALLOWED:Ravi Kumar');
  });
});

describe('fillText', () => {
  it('writes and verifies by reading back', () => {
    mount('<input id="a">');
    const outcome = fillText(el<HTMLInputElement>('#a'), 'Ravi Kumar');
    expect(outcome).toMatchObject({ ok: true, strategy: 'text', readBack: 'Ravi Kumar' });
  });

  it('dispatches input, change, and blur', () => {
    mount('<input id="a">');
    const input = el<HTMLInputElement>('#a');
    const seen: string[] = [];
    for (const type of ['input', 'change', 'blur', 'keydown', 'keyup']) {
      input.addEventListener(type, () => seen.push(type));
    }
    fillText(input, 'x');
    expect(seen).toEqual(expect.arrayContaining(['input', 'change', 'blur']));
  });

  it('bubbles input and change, so delegated handlers fire', () => {
    mount('<form id="f"><input id="a"></form>');
    const seen: string[] = [];
    el('#f').addEventListener('input', () => seen.push('input'));
    el('#f').addEventListener('change', () => seen.push('change'));
    fillText(el<HTMLInputElement>('#a'), 'x');
    expect(seen).toEqual(['input', 'change']);
  });

  it('truncates to maxLength and flags it rather than corrupting silently', () => {
    mount('<input id="a" maxlength="5">');
    const outcome = fillText(el<HTMLInputElement>('#a'), 'Ravi Kumar');
    expect(outcome).toMatchObject({ ok: true, truncated: true, readBack: 'Ravi ' });
  });

  it('does not flag truncation when the value fits', () => {
    mount('<input id="a" maxlength="40">');
    expect(fillText(el<HTMLInputElement>('#a'), 'Ravi').truncated).toBeUndefined();
  });

  it('reports failure when the field refuses the value', () => {
    mount('<input id="a">');
    const input = el<HTMLInputElement>('#a');
    // A page that resets the field on input, as some validators do.
    input.addEventListener('input', () => {
      input.setAttribute('value', '');
      Object.defineProperty(input, 'value', { configurable: true, value: '', writable: true });
    });

    const outcome = fillText(input, 'Ravi Kumar');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/did not keep/);
  });

  it('writes into a textarea', () => {
    mount('<textarea id="a"></textarea>');
    expect(fillText(el<HTMLTextAreaElement>('#a'), 'Some remarks').ok).toBe(true);
  });
});

describe('findOption — the four strategies in order', () => {
  beforeEach(() => {
    mount(`<select id="s">
      <option value="">-- Select State --</option>
      <option value="KA">Karnataka</option>
      <option value="MH">Maharashtra</option>
      <option value="TN">Tamil Nadu</option>
    </select>`);
  });

  it('prefers an exact option value', () => {
    expect(findOption(el<HTMLSelectElement>('#s'), 'KA')?.strategy).toBe('option-value');
  });

  it('falls back to exact option text', () => {
    const match = findOption(el<HTMLSelectElement>('#s'), 'Karnataka');
    expect(match?.strategy).toBe('option-exact-text');
    expect(match?.option.value).toBe('KA');
  });

  it('falls back to normalised text', () => {
    const match = findOption(el<HTMLSelectElement>('#s'), '  KARNATAKA  ');
    expect(match?.strategy).toBe('option-normalised-text');
    expect(match?.option.value).toBe('KA');
  });

  it('falls back to fuzzy, and flags it', () => {
    const match = findOption(el<HTMLSelectElement>('#s'), 'Karnatak');
    expect(match?.strategy).toBe('option-fuzzy');
    expect(match?.fuzzy).toBe(true);
    expect(match?.option.value).toBe('KA');
  });

  it('refuses a value nothing resembles', () => {
    expect(findOption(el<HTMLSelectElement>('#s'), 'Ontario')).toBeNull();
  });

  it('never fuzzy-matches the placeholder row', () => {
    const match = findOption(el<HTMLSelectElement>('#s'), 'Select');
    expect(match?.option.value).not.toBe('');
  });
});

describe('fillSelect', () => {
  beforeEach(() => {
    mount(`<select id="s">
      <option value="">-- Select --</option>
      <option value="KA">Karnataka</option>
    </select>`);
  });

  it('selects and verifies', () => {
    const outcome = fillSelect(el<HTMLSelectElement>('#s'), 'Karnataka');
    expect(outcome.ok).toBe(true);
    expect(el<HTMLSelectElement>('#s').value).toBe('KA');
  });

  it('reports a value the dropdown cannot hold', () => {
    const outcome = fillSelect(el<HTMLSelectElement>('#s'), 'Ontario');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/no option/);
  });

  it('flags a fuzzy selection for review', () => {
    expect(fillSelect(el<HTMLSelectElement>('#s'), 'Karnatka').fuzzy).toBe(true);
  });
});

describe('radio groups', () => {
  beforeEach(() => {
    mount(`
      <label><input type="radio" name="gender" value="M"> Male</label>
      <label><input type="radio" name="gender" value="F"> Female</label>
      <label><input type="radio" name="gender" value="T"> Transgender</label>
    `);
  });

  it('selects by label text', () => {
    const outcome = fillRadioGroup(el<HTMLInputElement>('input[value="M"]'), 'Female');
    expect(outcome.ok).toBe(true);
    expect(el<HTMLInputElement>('input[value="F"]').checked).toBe(true);
  });

  it('selects by option value', () => {
    fillRadioGroup(el<HTMLInputElement>('input[value="M"]'), 'T');
    expect(el<HTMLInputElement>('input[value="T"]').checked).toBe(true);
  });

  it('is case-insensitive on the label', () => {
    fillRadioGroup(el<HTMLInputElement>('input[value="M"]'), 'female');
    expect(el<HTMLInputElement>('input[value="F"]').checked).toBe(true);
  });

  it('refuses a value no member carries', () => {
    const outcome = fillRadioGroup(el<HTMLInputElement>('input[value="M"]'), 'Unspecified');
    expect(outcome.ok).toBe(false);
    expect(el<HTMLInputElement>('input[value="M"]').checked).toBe(false);
  });
});

describe('checkboxes', () => {
  it.each([['yes', true], ['true', true], ['1', true], ['no', false], ['false', false]])(
    'reads %s as %s',
    (value, expected) => {
      mount('<input type="checkbox" id="c">');
      fillCheckbox(el<HTMLInputElement>('#c'), value);
      expect(el<HTMLInputElement>('#c').checked).toBe(expected);
    },
  );
});

describe('fillElement dispatch', () => {
  it('routes each control kind correctly', () => {
    mount(`
      <input id="t"><textarea id="a"></textarea>
      <select id="s"><option value="KA">Karnataka</option></select>
      <input type="checkbox" id="c">
    `);
    expect(fillElement(el('#t'), 'x').strategy).toBe('text');
    expect(fillElement(el('#a'), 'x').strategy).toBe('text');
    expect(fillElement(el('#s'), 'KA').strategy).toBe('option-value');
    expect(fillElement(el('#c'), 'yes').strategy).toBe('checkbox');
  });

  it('refuses text for a file input', () => {
    mount('<input type="file" id="f">');
    const outcome = fillElement(el('#f'), 'not a file');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/needs a document/);
  });

  it('refuses a document for a text input', () => {
    mount('<input id="t">');
    const outcome = fillElement(el('#t'), {
      bytes: new Uint8Array([1]),
      mime: 'image/jpeg',
      filename: 'p.jpg',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/needs text/);
  });

  it('refuses an element it cannot write into', () => {
    mount('<div id="d"></div>');
    expect(fillElement(el('#d'), 'x').ok).toBe(false);
  });

  it('refuses a document for a dropdown', () => {
    mount('<select id="s"><option>a</option></select>');
    const outcome = fillElement(el('#s'), { bytes: new Uint8Array([1]), mime: 'image/jpeg', filename: 'p.jpg' });
    expect(outcome.reason).toMatch(/needs text/);
  });
});

describe('dropping a document on a drag-and-drop area', () => {
  /*
   * jsdom has neither `DataTransfer` nor `DragEvent`. These stand-ins carry
   * exactly what `fillDrop` uses; the real objects are exercised in a real
   * browser by `tests/e2e/documents.spec.ts`.
   */
  class FakeTransfer {
    readonly list: File[] = [];
    readonly items = { add: (file: File) => this.list.push(file) };
    get files() {
      return this.list;
    }
  }
  class FakeDragEvent extends Event {
    readonly dataTransfer: FakeTransfer;
    constructor(type: string, init: EventInit & { dataTransfer: FakeTransfer }) {
      super(type, init);
      this.dataTransfer = init.dataTransfer;
    }
  }

  beforeEach(() => {
    Object.assign(window, { DataTransfer: FakeTransfer, DragEvent: FakeDragEvent });
    return () => {
      Reflect.deleteProperty(window, 'DataTransfer');
      Reflect.deleteProperty(window, 'DragEvent');
    };
  });

  const doc = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg', filename: 'signature.jpg' };

  it('delivers the file, and counts it taken when the widget says so', () => {
    mount('<div id="zone"><span id="msg">Drop files here</span></div>');
    const received: string[] = [];
    el('#zone').addEventListener('drop', (event) => {
      event.preventDefault();
      const files = (event as unknown as FakeDragEvent).dataTransfer.files;
      received.push(...files.map((f) => `${f.name}:${f.type}:${f.size}`));
    });

    // Aimed at the message inside the widget: the drop bubbles to its handler.
    const outcome = fillElement(el('#msg'), doc);

    expect(outcome).toMatchObject({ ok: true, strategy: 'drop' });
    expect(received).toEqual(['signature.jpg:image/jpeg:3']);
  });

  it('reports a drop that nothing took, rather than claiming success', () => {
    mount('<div id="zone">Drop files here</div>');
    const outcome = fillElement(el('#zone'), doc);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/nothing on the page took/);
  });
});

describe('undo', () => {
  it('restores a text field to what it held before', () => {
    mount('<input id="a" value="original">');
    const input = el<HTMLInputElement>('#a');
    const before = snapshot('f0', input);

    fillText(input, 'overwritten');
    expect(input.value).toBe('overwritten');

    restore(input, before);
    expect(input.value).toBe('original');
  });

  it('restores a checkbox', () => {
    mount('<input type="checkbox" id="c" checked>');
    const box = el<HTMLInputElement>('#c');
    const before = snapshot('f0', box);

    fillCheckbox(box, 'no');
    expect(box.checked).toBe(false);

    restore(box, before);
    expect(box.checked).toBe(true);
  });

  it('empties a file box that was empty before, without throwing', () => {
    mount('<input type="file" id="f">');
    const input = el<HTMLInputElement>('#f');
    const before = snapshot('f0', input);
    expect(before.files).toBeDefined();

    // `.value` on a file box can only be set to ''. Undo used to set it to
    // the snapshot's value, which throws once the box holds a file.
    expect(restore(input, before)).toBe(true);
    expect(input.value).toBe('');
  });

  it('never writes to a drop area — there is nothing of ours to put back', () => {
    mount('<div id="zone">Drop files here</div>');
    const zone = el('#zone');
    const before = snapshot('u0', zone);
    const seen = vi.fn();
    zone.addEventListener('change', seen);

    expect(before.inert).toBe(true);
    expect(restore(zone, before)).toBe(false);
    expect(seen).not.toHaveBeenCalled();
    expect(zone.outerHTML).toBe('<div id="zone">Drop files here</div>');
  });

  it('dispatches events on restore, so the page sees the revert', () => {
    mount('<input id="a" value="original">');
    const input = el<HTMLInputElement>('#a');
    const before = snapshot('f0', input);
    fillText(input, 'x');

    const seen = vi.fn();
    input.addEventListener('change', seen);
    restore(input, before);
    expect(seen).toHaveBeenCalled();
  });
});

describe('the filler never submits', () => {
  it('does not trigger submit while writing values', () => {
    mount('<form id="f"><input id="a"><button type="submit">Go</button></form>');
    const submitted = vi.fn();
    el('#f').addEventListener('submit', submitted);

    fillText(el<HTMLInputElement>('#a'), 'Ravi');
    fillText(el<HTMLInputElement>('#a'), 'Kumar');

    expect(submitted).not.toHaveBeenCalled();
  });

  it('does not click anything', () => {
    mount('<form id="f"><input id="a"><button id="b" type="submit">Go</button></form>');
    const clicked = vi.fn();
    el('#b').addEventListener('click', clicked);
    fillText(el<HTMLInputElement>('#a'), 'Ravi');
    expect(clicked).not.toHaveBeenCalled();
  });
});
