import { describe, expect, it } from 'vitest';
import { fingerprintForm, fingerprintSource, labelTokens, normaliseToken } from './plan';
import type { FieldDescriptor } from '@/shared/types';

/**
 * The fingerprint is the key a paused run is stored under (§5). It has two
 * failure modes and both are bad:
 *
 *   - too sensitive → a postback looks like a different form, and the run is lost
 *   - too loose     → two different forms collide, resuming the wrong data
 *
 * So these tests come in pairs: "survives X" and "changes on Y".
 */
function field(labelText: string): Pick<FieldDescriptor, 'labelText' | 'selectors' | 'tag'> {
  return { labelText, selectors: [], tag: 'input' };
}

const BASE = {
  url: 'https://portal.example.gov.in/apply/form',
  formAction: '/apply/submit',
  fields: [field("Father's Name"), field('Date of Birth'), field('PIN Code')],
  identifiers: ['txtFName', 'txtDob', 'txtPin'],
};

describe('normaliseToken', () => {
  it.each([
    '__VIEWSTATE',
    '__VIEWSTATEGENERATOR',
    '__EVENTVALIDATION',
    '__RequestVerificationToken',
    'csrf_token',
    'authenticity_token',
  ])('drops the volatile field %s', (name) => {
    expect(normaliseToken(name)).toBeNull();
  });

  it('keeps only the leaf of an ASP.NET container name', () => {
    expect(normaliseToken('ctl00$ContentPlaceHolder1$txtFatherName')).toBe('txtfathername');
  });

  it('strips a trailing index suffix so repeated rows agree', () => {
    expect(normaliseToken('education_1')).toBe(normaliseToken('education_2'));
  });

  it('drops purely numeric and too-short identifiers', () => {
    expect(normaliseToken('12345')).toBeNull();
    expect(normaliseToken('a')).toBeNull();
    expect(normaliseToken('')).toBeNull();
  });

  it('normalises separators and case', () => {
    expect(normaliseToken('Father_Name')).toBe(normaliseToken('father-name'));
  });
});

describe('labelTokens', () => {
  it('lowercases and drops short words and punctuation', () => {
    expect(labelTokens("Father's Name *")).toEqual(['father', 'name']);
  });

  it('handles non-Latin labels', () => {
    expect(labelTokens('पिता का नाम').length).toBeGreaterThan(0);
  });

  it('caps the number of tokens taken from one label', () => {
    expect(labelTokens('one two three four five six seven').length).toBeLessThanOrEqual(4);
  });
});

describe('fingerprintSource — stability', () => {
  it('is unchanged by a query string', async () => {
    const a = fingerprintSource(BASE);
    const b = fingerprintSource({ ...BASE, url: `${BASE.url}?sessionId=abc123` });
    expect(a).toBe(b);
  });

  it('is unchanged when ASP.NET regenerates control ids', () => {
    const a = fingerprintSource(BASE);
    const b = fingerprintSource({
      ...BASE,
      identifiers: [
        'ctl00$ContentPlaceHolder1$txtFName',
        'ctl00$ContentPlaceHolder1$txtDob',
        'ctl00$ContentPlaceHolder1$txtPin',
      ],
    });
    // Leaf names survive the container prefix.
    expect(a).toBe(b);
  });

  it('is unchanged by __VIEWSTATE appearing among the fields', () => {
    const a = fingerprintSource(BASE);
    const b = fingerprintSource({
      ...BASE,
      identifiers: [...BASE.identifiers, '__VIEWSTATE', '__EVENTVALIDATION'],
    });
    expect(a).toBe(b);
  });

  it('is unchanged by field order', () => {
    const a = fingerprintSource(BASE);
    const b = fingerprintSource({
      ...BASE,
      fields: [...BASE.fields].reverse(),
      identifiers: [...BASE.identifiers].reverse(),
    });
    expect(a).toBe(b);
  });

  it('is unchanged by a session id embedded in the path', () => {
    const a = fingerprintSource({ ...BASE, url: 'https://p.example.in/apply/form' });
    const b = fingerprintSource({
      ...BASE,
      url: 'https://p.example.in/apply/8f14e45fceea167a5a36dedd4bea2543/form',
    });
    expect(a).toBe(b);
  });

  it('is unchanged by a query string on the form action', () => {
    const a = fingerprintSource(BASE);
    const b = fingerprintSource({ ...BASE, formAction: '/apply/submit?ts=1699999' });
    expect(a).toBe(b);
  });
});

describe('fingerprintSource — sensitivity', () => {
  it('changes on a different origin', () => {
    expect(fingerprintSource(BASE)).not.toBe(
      fingerprintSource({ ...BASE, url: 'https://other.gov.in/apply/form' }),
    );
  });

  it('changes on a different path', () => {
    expect(fingerprintSource(BASE)).not.toBe(
      fingerprintSource({ ...BASE, url: 'https://portal.example.gov.in/apply/other' }),
    );
  });

  it('changes when the fields genuinely differ', () => {
    expect(fingerprintSource(BASE)).not.toBe(
      fingerprintSource({
        ...BASE,
        fields: [field('Bank Account Number'), field('IFSC Code')],
        identifiers: ['txtAccount', 'txtIfsc'],
      }),
    );
  });

  it('changes on a different wizard step — step 3 is not step 1', () => {
    const step1 = fingerprintSource({ ...BASE, step: 1 });
    const step3 = fingerprintSource({ ...BASE, step: 3 });
    expect(step1).not.toBe(step3);
  });

  it('treats no step and step 1 as different, rather than guessing', () => {
    expect(fingerprintSource(BASE)).not.toBe(fingerprintSource({ ...BASE, step: 1 }));
  });

  it('changes on a different form action path', () => {
    expect(fingerprintSource(BASE)).not.toBe(
      fingerprintSource({ ...BASE, formAction: '/apply/other-handler' }),
    );
  });
});

describe('fingerprintForm', () => {
  it('produces a stable 32-character hex digest', async () => {
    const hash = await fingerprintForm(BASE);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(await fingerprintForm(BASE)).toBe(hash);
  });

  it('differs when the source differs', async () => {
    const a = await fingerprintForm(BASE);
    const b = await fingerprintForm({ ...BASE, step: 2 });
    expect(a).not.toBe(b);
  });

  it('survives a simulated postback that rewrites every id', async () => {
    const before = await fingerprintForm(BASE);
    const after = await fingerprintForm({
      ...BASE,
      url: `${BASE.url}?__EVENTTARGET=ctl00%24btnNext`,
      identifiers: BASE.identifiers.map((id) => `ctl00$ContentPlaceHolder1$${id}`),
    });
    expect(after).toBe(before);
  });

  it('tolerates a malformed URL rather than throwing', async () => {
    await expect(fingerprintForm({ ...BASE, url: 'not a url' })).resolves.toMatch(/^[0-9a-f]{32}$/);
  });
});
