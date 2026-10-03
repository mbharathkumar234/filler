// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchForm } from '@/matching/deterministic';
import { fillField } from './fill-field';
import { runFill } from './fill-run';
import { harvest } from './harvester';
import { mayPress, pressChoice, readChoice } from './choice-widgets';
import { readValue } from './reverify';

/**
 * Choice questions that are not form controls (§ choice questions).
 *
 * `fixtures/choice-portal/google-form.html` copies a Google Form's structure —
 * role="listbox" and role="radiogroup" divs, data-value on every option,
 * "Other:" as __other_option__ with its box — and its behaviour: nothing
 * changes unless an option is pressed. Its own script runs here, so these
 * tests pass only if the page itself took the answer.
 */

const PAGES = import.meta.glob('../../fixtures/choice-portal/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const page = (name: string) => Object.entries(PAGES).find(([path]) => path.endsWith(name))![1];

function mount(html: string, { scripts = true } = {}): void {
  document.head.innerHTML = '';
  for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const style = document.createElement('style');
    style.textContent = match[1] ?? '';
    document.head.append(style);
  }
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  if (!scripts) return;
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/gi)) {
    // The fixture's own behaviour, as the page would run it.
    new Function(match[1] ?? '')();
  }
}

const noWait = () => Promise.resolve();

/** The question whose heading says `heading`. */
function question(heading: string): Element {
  const title = [...document.querySelectorAll('[role="heading"]')].find((el) =>
    (el.textContent ?? '').includes(heading),
  );
  const group = title?.closest('[role="listitem"]')?.querySelector('[role="radiogroup"], [role="listbox"]');
  if (!group) throw new Error(`no question "${heading}"`);
  return group;
}

const entry = (group: Element) =>
  (group.closest('[role="listitem"]')!.querySelector('input[type="hidden"]') as HTMLInputElement).value;

describe('finding a Google Form’s choice questions', () => {
  beforeEach(() => mount(page('google-form.html')));

  it('sees each dropdown and multiple-choice question as one field, with its options', () => {
    const { fields } = harvest(document);
    const gender = fields.find((f) => f.labelText.startsWith('Gender'));
    expect(gender).toMatchObject({ tag: 'radio-group', required: true });
    expect(gender?.options?.map((o) => o.text)).toEqual(['Male', 'Female', 'Prefer not to say', 'Other:']);

    const field = fields.find((f) => f.labelText.includes('field of study'));
    expect(field?.tag).toBe('select');
    // The open list's copies are the same options, counted once.
    expect(field?.options?.map((o) => o.text)).toEqual([
      'Choose',
      'Computer Science / IT',
      'Electronics / Communication',
      'Mechanical / Civil Engineering',
      'Commerce / Business Administration',
      'Arts / Humanities',
      'Science / Pure Sciences',
      'Other',
    ]);
  });

  it('does not take an "Other response" box for a question of its own', () => {
    const { fields } = harvest(document);
    expect(fields.some((f) => /other response/i.test(f.labelText))).toBe(false);
    expect(fields).toHaveLength(7);
  });

  it('matches every question to the answer it asks for', () => {
    const { fields, elements } = harvest(document);
    const keys = matchForm(fields).map((match) => match.key);
    const expected = fields.map((f) => elements.get(f.ref)!.getAttribute('data-expect'));
    expect(keys).toEqual(expected);
  });

  it('passes over an autocomplete’s list of suggestions', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<input role="combobox" aria-controls="sugg" aria-label="City">
       <div role="listbox" id="sugg"><div role="option">Mysuru</div><div role="option">Mangaluru</div></div>`,
    );
    const { fields } = harvest(document);
    expect(fields.filter((f) => f.tag === 'select' && f.options?.some((o) => o.text === 'Mysuru'))).toEqual([]);
  });
});

describe('answering them by pressing an option', () => {
  beforeEach(() => mount(page('google-form.html')));

  it('presses the radio a value means', async () => {
    const gender = question('Gender');
    const outcome = await fillField(gender, 'M', noWait);
    expect(outcome).toMatchObject({ ok: true, strategy: 'option-meaning', readBack: 'Male' });
    expect(entry(gender)).toBe('Male');
  });

  it('opens a dropdown, presses the option, and leaves it closed — the screenshot’s question', async () => {
    const field = question('field of study');
    const outcome = await fillField(field, 'Computer Science and Engineering', noWait);
    expect(outcome).toMatchObject({ ok: true, strategy: 'option-family', fuzzy: true, readBack: 'Computer Science / IT' });
    expect(entry(field)).toBe('Computer Science / IT');
    expect(field.getAttribute('aria-expanded')).toBe('false');
  });

  it('chooses a category, an income band and a board by what they mean', async () => {
    await fillField(question('Reservation category'), 'GM', noWait);
    await fillField(question('Annual family income'), '30000', noWait);
    await fillField(question('Board of your Class 10'), 'KARNATAKA SECONDARY EDUCATION EXAMINATION BOARD', noWait);
    expect(entry(question('Reservation category'))).toBe('General / Unreserved');
    expect(entry(question('Annual family income'))).toBe('Below ₹1,00,000');
    expect(entry(question('Board of your Class 10'))).toBe('State Board');
  });

  it('chooses "Other:" and writes the answer in its box', async () => {
    const university = question('Which university');
    const outcome = await fillField(university, 'Tumkur University', noWait);
    expect(outcome).toMatchObject({ ok: true, strategy: 'option-other', readBack: 'Tumkur University' });
    expect(university.querySelector('[data-value="__other_option__"]')!.getAttribute('aria-checked')).toBe('true');
    expect(entry(university)).toBe('Tumkur University');
  });

  it('chooses a dropdown’s "Other", and says there was no box for the answer', async () => {
    const outcome = await fillField(question('field of study'), 'MBBS', noWait);
    expect(outcome).toMatchObject({ ok: true, strategy: 'option-other', fuzzy: true });
    expect(outcome.reason).toMatch(/no box/);
    expect(entry(question('field of study'))).toBe('Other');
  });

  it('leaves the question untouched when nothing fits and there is no "Other"', async () => {
    const category = question('Reservation category');
    const outcome = await fillField(category, 'Nomadic Tribe', noWait);
    expect(outcome.ok).toBe(false);
    expect(category.querySelectorAll('[aria-checked="true"]')).toHaveLength(0);
  });

  it('does not press again what is already chosen', async () => {
    const gender = question('Gender');
    await fillField(gender, 'Female', noWait);
    const clicks = vi.fn();
    gender.addEventListener('click', clicks);
    expect((await fillField(gender, 'Female', noWait)).ok).toBe(true);
    expect(clicks).not.toHaveBeenCalled();
  });

  it('reads back what is chosen, and nothing for a dropdown still on "Choose"', async () => {
    expect(readValue(question('field of study'))).toBe('');
    expect(readValue(question('Gender'))).toBe('');
    await fillField(question('Gender'), 'Male', noWait);
    expect(readChoice(question('Gender'))).toBe('Male');
    expect(readValue(question('Gender'))).toBe('Male');
  });

  it('fills the whole form and never presses Submit or Clear form', async () => {
    const { fields, elements } = harvest(document);
    const pressed = vi.fn();
    for (const button of document.querySelectorAll('[role="button"]')) button.addEventListener('click', pressed);
    const submitted = vi.fn();
    document.getElementById('mG61Hd')!.addEventListener('submit', submitted);

    const answers: Record<string, string> = {
      'identity.full_name': 'Meera Nair',
      'identity.gender': 'Female',
      'education[].branch': 'Information Science and Engineering',
      'identity.category': 'OBC',
      'family.annual_income': '2,75,000',
      'education.class_10.board_or_university': 'CBSE',
      'education[].board_or_university': 'Tumkur University',
    };
    const keys = matchForm(fields).map((m) => m.key);
    const writes = fields.map((f, i) => ({ ref: f.ref, key: keys[i]!, value: answers[keys[i]!]! }));
    const { records } = await runFill(writes, { resolve: (ref) => elements.get(ref) ?? null, delay: noWait });

    expect(records.every((r) => r.ok)).toBe(true);
    expect(pressed).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
    expect(document.getElementById('mG61Hd')!.hasAttribute('data-submitted')).toBe(false);
    expect(
      [...document.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => input.value),
    ).toEqual([
      '', // the name box is typed into; this page copies only the choices to their entries
      'Female',
      'Computer Science / IT',
      'OBC',
      '₹2,50,001 – ₹5,00,000',
      'CBSE',
      'Tumkur University',
    ]);
  });
});

describe('the press, and what it refuses', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  const refused = (html: string, selector: string) => {
    document.body.innerHTML = html;
    const clicks = vi.fn();
    document.addEventListener('click', clicks, { capture: true, once: false });
    const el = document.querySelector(selector)!;
    const result = { may: mayPress(el), pressed: pressChoice(el) };
    document.removeEventListener('click', clicks, { capture: true });
    return { ...result, clicked: clicks.mock.calls.length };
  };

  it('presses a radio, an option and a list, as a person does', () => {
    document.body.innerHTML = '<div role="radio" id="r" aria-label="Yes"></div>';
    const seen: string[] = [];
    for (const type of ['mousedown', 'mouseup', 'click']) {
      document.getElementById('r')!.addEventListener(type, () => seen.push(type));
    }
    expect(pressChoice(document.getElementById('r')!)).toBe(true);
    expect(seen).toEqual(['mousedown', 'mouseup', 'click']);
  });

  it.each([
    ['a button, whatever its role says', '<button role="option" id="x">Computer Science</button>'],
    ['anything inside a link', '<a href="/next"><div role="radio" id="x" aria-label="Yes"></div></a>'],
    ['anything inside a button', '<div role="button"><div role="option" id="x">Yes</div></div>'],
    ['a role="button"', '<div role="button" id="x">Next</div>'],
    ['an option that reads as a submit', '<div role="option" id="x">Submit</div>'],
    ['a checkbox, which a second press would undo', '<div role="checkbox" id="x" aria-label="I agree"></div>'],
    [
      'a label that would pass the press to a submit',
      '<label for="go"><div role="radio" id="x" aria-label="Yes"></div></label><input type="submit" id="go">',
    ],
  ])('refuses %s', (_, html) => {
    expect(refused(html, '#x')).toEqual({ may: false, pressed: false, clicked: 0 });
  });
});

describe('a native dropdown or radio group answered "Other"', () => {
  it('matches every question, and leaves each "Other" box to its question', () => {
    mount(page('native-other.html'), { scripts: false });
    const { fields, elements } = harvest(document);
    const keys = matchForm(fields).map((match) => match.key);
    expect(keys).toEqual(fields.map((f) => elements.get(f.ref)!.getAttribute('data-expect')));
    // A radio group is named by its question, not by its first option.
    expect(fields.filter((f) => f.tag === 'radio-group').map((f) => f.labelText)).toEqual([
      'Gender',
      'Category',
      'Religion',
    ]);
  });

  it('chooses "Others (please specify)" and writes the answer in the box it reveals', async () => {
    mount(page('native-other.html'));
    const university = document.getElementById('university') as HTMLSelectElement;
    const outcome = await fillField(university, 'Tumkur University', noWait);
    expect(outcome).toMatchObject({ ok: true, strategy: 'option-other' });
    expect(university.value).toBe('OTH');
    expect((document.getElementById('uniOther') as HTMLInputElement).value).toBe('Tumkur University');
  });

  it('writes a radio group’s "Others" answer in the box beside it', async () => {
    mount(page('native-other.html'));
    const outcome = await fillField(document.querySelector('input[name="religion"]')!, 'Jain', noWait);
    expect(outcome).toMatchObject({ ok: true, strategy: 'option-other' });
    expect(document.querySelector<HTMLInputElement>('input[value="Others"]')!.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[name="religion_other"]')!.value).toBe('Jain');
  });

  it('chooses by meaning on native controls too', async () => {
    mount(page('native-other.html'));
    await fillField(document.querySelector('input[name="gender"]')!, 'Male', noWait);
    await fillField(document.querySelector('input[name="category"]')!, 'Scheduled Tribe', noWait);
    await fillField(document.getElementById('income')!, '120000', noWait);
    await fillField(document.getElementById('blood')!, 'B+', noWait);
    expect(document.querySelector<HTMLInputElement>('input[name="gender"]:checked')!.value).toBe('1');
    expect(document.querySelector<HTMLInputElement>('input[name="category"]:checked')!.value).toBe('ST');
    expect((document.getElementById('income') as HTMLSelectElement).value).toBe('2');
    expect((document.getElementById('blood') as HTMLSelectElement).value).toBe('B Positive');
  });

  it('says so when the box never appears, and types nowhere else', async () => {
    mount(page('native-other.html'), { scripts: false });
    const outcome = await fillField(document.getElementById('university')!, 'Tumkur University', noWait);
    expect(outcome).toMatchObject({ ok: true, fuzzy: true });
    expect(outcome.reason).toMatch(/no box/);
    expect((document.getElementById('uniOther') as HTMLInputElement).value).toBe('');
  });

  it('never writes the answer into the next question’s box', async () => {
    document.head.innerHTML = '';
    document.body.innerHTML = `
      <label for="u">University</label>
      <select id="u"><option value="">Select</option><option>VTU</option><option>Other</option></select>
      <label for="h">Hobbies</label><input id="h" type="text">`;
    const outcome = await fillField(document.getElementById('u')!, 'Tumkur University', noWait);
    expect(outcome.reason).toMatch(/no box/);
    expect((document.getElementById('h') as HTMLInputElement).value).toBe('');
  });
});
