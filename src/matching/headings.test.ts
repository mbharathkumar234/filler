// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { harvest } from '@/content/harvester';
import { resolveNearbyText } from '@/content/labels';
import { NEARBY_SEPARATOR } from '@/shared/types';
import { matchForm } from './deterministic';
import { headingSubject } from './frame';

/**
 * Section headings carry their subject down to the boxes beneath them.
 *
 * Under "Father's Details", a box labelled only "Name" is the father's name.
 * Before this, it matched the applicant's own name at 0.80 — written, not just
 * suggested — and a bare "Mobile Number" there took the applicant's number.
 *
 * The end-to-end cases use real markup through the real harvester and the real
 * matcher, because what is under test is the seam between them:
 * `resolveNearbyText` decides which heading governs a box, and `frame.ts`
 * decides what that heading means.
 */

const join = (...parts: string[]) => parts.join(NEARBY_SEPARATOR);

/** Harvest and match a page; key by the control's id. */
function keysOf(html: string): Record<string, string> {
  document.body.innerHTML = html;
  const fields = harvest(document).fields;
  const results = matchForm(fields);
  const byId: Record<string, string> = {};
  fields.forEach((field, index) => {
    const id = field.selectors.find((selector) => selector.startsWith('#'))?.slice(1) ?? field.ref;
    byId[id] = results[index]!.key;
  });
  return byId;
}

describe('which headings carry a subject', () => {
  it.each([
    ["Father's Details", 'father'],
    ['Details of Mother', 'mother'],
    ['Part B — Father’s Particulars', 'father'], // a dash inside one heading is not a separator
    ['Father', 'father'],
    ["Mother's", 'mother'],
    ['Father / Guardian', 'father'],
    ['Parent/Guardian Details', 'guardian'],
    ['Emergency Contact', 'emergency'],
    ['पिता का विवरण', 'father'],
  ])('%s → %s', (heading, subject) => {
    expect(headingSubject(heading)).toBe(subject);
  });

  it.each([
    ["Father's Name"], // a question set as a heading, not a section
    ["Father's Mobile Number"],
    ['Applicant and Father Details'], // names the applicant too
    ['Personal Details'],
    ['Contact Details'],
    ['Mother Tongue'],
    [''],
  ])('%s carries nothing', (heading) => {
    expect(headingSubject(heading)).toBeUndefined();
  });

  it('lets only the nearest heading decide', () => {
    expect(headingSubject(join('Mother', 'Family Details'))).toBe('mother');
    // A nearer heading that names nobody ends an older one's reach.
    expect(headingSubject(join('Contact Details', "Father's Details"))).toBeUndefined();
  });
});

describe('which heading is nearest', () => {
  it('puts a heading inside the fieldset before the fieldset’s legend', () => {
    document.body.innerHTML =
      '<fieldset><legend>Family Details</legend><h4>Mother</h4><p><input id="z"></p></fieldset>';
    expect(resolveNearbyText(document.getElementById('z')!).split(NEARBY_SEPARATOR)).toEqual([
      'Mother',
      'Family Details',
    ]);
  });

  it('keeps the legend first when the heading sits outside the fieldset', () => {
    document.body.innerHTML =
      '<h2>Applicant</h2><fieldset><legend>Bank Details</legend><p><input id="z"></p></fieldset>';
    expect(resolveNearbyText(document.getElementById('z')!).split(NEARBY_SEPARATOR)).toEqual([
      'Bank Details',
      'Applicant',
    ]);
  });

  it('takes the last of several headings in the block before, not the first', () => {
    document.body.innerHTML =
      "<div><div><h3>Father's Details</h3><h3>Mother's Details</h3></div><p><input id=\"z\"></p></div>";
    expect(resolveNearbyText(document.getElementById('z')!)).toBe("Mother's Details");
  });
});

describe('carrying a subject down, end to end', () => {
  it('re-homes bare boxes under a family member’s heading', () => {
    const keys = keysOf(`
      <form>
        <h2>Applicant Details</h2>
        <p><label for="a1">Name</label><input id="a1"></p>
        <p><label for="a2">Mobile Number</label><input id="a2"></p>
        <fieldset><legend>Father's Details</legend>
          <p><label for="f1">Name</label><input id="f1"></p>
          <p><label for="f2">Mobile Number</label><input id="f2"></p>
          <p><label for="f3">Email</label><input id="f3" type="email"></p>
        </fieldset>
        <fieldset><legend>Mother's Details</legend>
          <p><label for="m1">Name</label><input id="m1"></p>
        </fieldset>
      </form>`);

    expect(keys).toMatchObject({
      a1: 'identity.full_name',
      a2: 'contact.mobile',
      f1: 'family.father_name',
      f2: 'family.father_mobile',
      f3: 'family.father_email',
      m1: 'family.mother_name',
    });
  });

  it('leaves a box blank when the heading’s person has no such saved value', () => {
    const keys = keysOf(`
      <fieldset><legend>Father's Details</legend>
        <p><label for="f4">Date of Birth</label><input id="f4"></p>
      </fieldset>
      <fieldset><legend>Mother's Details</legend>
        <p><label for="m2">Occupation</label><input id="m2"></p>
      </fieldset>`);

    // Not the applicant's date of birth, and not the father's occupation.
    expect(keys).toMatchObject({ f4: 'unknown', m2: 'unknown' });
  });

  it('reads Father and Mother subsections inside one Family Details fieldset', () => {
    const keys = keysOf(`
      <fieldset><legend>Family Details</legend>
        <h4>Father</h4>
        <p><label for="x1">Name</label><input id="x1"></p>
        <p><label for="x2">Mobile</label><input id="x2"></p>
        <h4>Mother</h4>
        <p><label for="x3">Name</label><input id="x3"></p>
      </fieldset>`);

    expect(keys).toMatchObject({
      x1: 'family.father_name',
      x2: 'family.father_mobile',
      x3: 'family.mother_name',
    });
  });

  it('stops carrying at the next heading, even one that names nobody', () => {
    const keys = keysOf(`
      <h3>Father's Details</h3>
      <p><label for="h1">Name</label><input id="h1"></p>
      <h3>Contact Details</h3>
      <p><label for="h2">Mobile Number</label><input id="h2"></p>`);

    expect(keys).toMatchObject({ h1: 'family.father_name', h2: 'contact.mobile' });
  });

  it('does not borrow a subject from a question set as a heading', () => {
    // Form builders that give every question its own heading: the one above
    // "Mobile Number" is a question about the father, not a section.
    const keys = keysOf(`
      <div><h4>Father's Name</h4><label for="g1">Father's Name</label><input id="g1"></div>
      <div><label for="g2">Mobile Number</label><input id="g2"></div>`);

    expect(keys).toMatchObject({ g1: 'family.father_name', g2: 'contact.mobile' });
  });

  it('lets a box’s own label outrank its heading', () => {
    const keys = keysOf(`
      <fieldset><legend>Father's Details</legend>
        <p><label for="o1">Mother's Name</label><input id="o1"></p>
      </fieldset>`);
    expect(keys).toMatchObject({ o1: 'family.mother_name' });
  });

  it('carries an emergency contact heading', () => {
    const keys = keysOf(`
      <h3>Emergency Contact</h3>
      <p><label for="e1">Name</label><input id="e1"></p>
      <p><label for="e2">Mobile Number</label><input id="e2"></p>`);
    expect(keys).toMatchObject({ e1: 'emergency.name', e2: 'emergency.mobile' });
  });

  it('carries nothing from a heading that names the applicant as well', () => {
    const keys = keysOf(`
      <h3>Applicant and Father Details</h3>
      <p><label for="k1">Name</label><input id="k1"></p>`);
    expect(keys).toMatchObject({ k1: 'identity.full_name' });
  });
});
