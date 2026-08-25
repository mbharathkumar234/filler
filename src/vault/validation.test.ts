import { describe, expect, it } from 'vitest';
import {
  hasValidator,
  normaliseDigits,
  validateAadhaar,
  validateDob,
  validateEmail,
  validateField,
  validateIfsc,
  validateMobile,
  validatePan,
  validatePincode,
  verhoeffCheckDigit,
  verhoeffValid,
} from './validation';

/**
 * Every Aadhaar number here is synthetic — generated to satisfy the Verhoeff
 * checksum for testing. None belongs to a person.
 */
const VALID_AADHAAR = ['234567890124', '987654321012', '345678901238', '500000000006'];

describe('Verhoeff checksum', () => {
  it.each(VALID_AADHAAR)('accepts %s', (value) => {
    expect(verhoeffValid(value)).toBe(true);
  });

  it('rejects any single-digit corruption', () => {
    const base = '234567890124';
    for (let i = 0; i < base.length; i += 1) {
      const digit = Number(base[i]);
      const corrupted = `${base.slice(0, i)}${(digit + 1) % 10}${base.slice(i + 1)}`;
      expect(verhoeffValid(corrupted), `position ${i}`).toBe(false);
    }
  });

  it('rejects adjacent transpositions, which a plain mod-10 sum would miss', () => {
    const base = '234567890124';
    for (let i = 0; i < base.length - 1; i += 1) {
      if (base[i] === base[i + 1]) continue;
      const swapped = `${base.slice(0, i)}${base[i + 1]}${base[i]}${base.slice(i + 2)}`;
      expect(verhoeffValid(swapped), `swap at ${i}`).toBe(false);
    }
  });

  it('computes a check digit that makes the number valid', () => {
    const base = '23456789012';
    expect(verhoeffValid(base + verhoeffCheckDigit(base))).toBe(true);
  });

  it('rejects non-numeric input', () => {
    expect(verhoeffValid('23456789012X')).toBe(false);
  });
});

describe('validateAadhaar', () => {
  it.each(VALID_AADHAAR)('accepts %s', (value) => {
    expect(validateAadhaar(value).valid).toBe(true);
  });

  it('accepts the spaced form users actually type', () => {
    expect(validateAadhaar('2345 6789 0124').valid).toBe(true);
    expect(validateAadhaar('2345-6789-0124').valid).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(validateAadhaar('23456789012').valid).toBe(false);
    expect(validateAadhaar('2345678901245').valid).toBe(false);
  });

  it('rejects numbers starting 0 or 1, which UIDAI never issues', () => {
    expect(validateAadhaar('012345678901').valid).toBe(false);
    expect(validateAadhaar('112345678901').valid).toBe(false);
  });

  it('rejects a checksum failure with a message that names the cause', () => {
    const result = validateAadhaar('234567890125');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/checksum/i);
  });

  it('never echoes the value back in the error message', () => {
    const result = validateAadhaar('234567890125');
    expect(result.message ?? '').not.toContain('234567890125');
  });
});

describe('validatePan', () => {
  it('accepts a well-formed PAN', () => {
    expect(validatePan('ABCPE1234F').valid).toBe(true);
  });

  it('is case-insensitive on input', () => {
    expect(validatePan('abcpe1234f').valid).toBe(true);
  });

  it('rejects a malformed shape', () => {
    expect(validatePan('ABCD1234F').valid).toBe(false);
    expect(validatePan('ABCPE12345').valid).toBe(false);
    expect(validatePan('12345ABCDF').valid).toBe(false);
  });

  it('rejects an invalid holder-type character in position 4', () => {
    const result = validatePan('ABCXE1234F');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/holder type/i);
  });
});

describe('validateIfsc', () => {
  it('accepts a well-formed IFSC', () => {
    expect(validateIfsc('SBIN0001234').valid).toBe(true);
    expect(validateIfsc('hdfc0ABC123').valid).toBe(true);
  });

  it('requires the 5th character to be zero', () => {
    expect(validateIfsc('SBIN1001234').valid).toBe(false);
  });

  it('rejects the wrong length', () => {
    expect(validateIfsc('SBIN000123').valid).toBe(false);
    expect(validateIfsc('SBIN00012345').valid).toBe(false);
  });
});

describe('validatePincode', () => {
  it('accepts a six-digit PIN', () => {
    expect(validatePincode('560001').valid).toBe(true);
    expect(validatePincode('110 001').valid).toBe(true);
  });

  it('rejects the wrong length or a leading zero', () => {
    expect(validatePincode('56001').valid).toBe(false);
    expect(validatePincode('5600012').valid).toBe(false);
    expect(validatePincode('060001').valid).toBe(false);
  });
});

describe('validateMobile', () => {
  it('accepts a ten-digit number starting 6-9', () => {
    expect(validateMobile('9876543210').valid).toBe(true);
    expect(validateMobile('6000000000').valid).toBe(true);
  });

  it('accepts the +91 and 91 prefixes', () => {
    expect(validateMobile('+919876543210').valid).toBe(true);
    expect(validateMobile('91 98765 43210').valid).toBe(true);
  });

  it('rejects numbers starting below 6', () => {
    expect(validateMobile('5876543210').valid).toBe(false);
  });

  it('rejects the wrong length', () => {
    expect(validateMobile('98765432').valid).toBe(false);
  });
});

describe('validateEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(validateEmail('someone@example.com').valid).toBe(true);
    expect(validateEmail('first.last@sub.example.co.in').valid).toBe(true);
  });

  it('rejects addresses with no domain dot or no local part', () => {
    expect(validateEmail('someone@example').valid).toBe(false);
    expect(validateEmail('@example.com').valid).toBe(false);
    expect(validateEmail('someone example.com').valid).toBe(false);
  });
});

describe('validateDob', () => {
  const now = new Date('2026-08-25T00:00:00Z');

  it('accepts a plausible date of birth', () => {
    expect(validateDob('2001-05-14', now).valid).toBe(true);
  });

  it('rejects a non-existent calendar date', () => {
    const result = validateDob('2025-02-30', now);
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/does not exist/i);
  });

  it('rejects a future date', () => {
    const result = validateDob('2027-01-01', now);
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/future/i);
  });

  it('accepts today', () => {
    expect(validateDob('2026-08-25', now).valid).toBe(true);
  });

  it('rejects an implausibly distant year, the classic typo', () => {
    expect(validateDob('1002-05-14', now).valid).toBe(false);
  });

  it('rejects a non-ISO format rather than guessing the order', () => {
    expect(validateDob('14/05/2001', now).valid).toBe(false);
    expect(validateDob('05-14-2001', now).valid).toBe(false);
  });
});

describe('validateField dispatch', () => {
  it('routes each key to its validator', () => {
    expect(validateField('id.aadhaar', '234567890125').valid).toBe(false);
    expect(validateField('id.pan', 'ABCPE1234F').valid).toBe(true);
    expect(validateField('bank.ifsc', 'nope').valid).toBe(false);
    expect(validateField('address.correspondence.pincode', '560001').valid).toBe(true);
  });

  it('accepts an empty value — validation is not a required-field check', () => {
    expect(validateField('id.aadhaar', '').valid).toBe(true);
    expect(validateField('id.aadhaar', '   ').valid).toBe(true);
  });

  it('accepts any value for a key with no registered validator', () => {
    expect(validateField('identity.full_name', 'anything at all').valid).toBe(true);
    expect(hasValidator('identity.full_name')).toBe(false);
    expect(hasValidator('id.aadhaar')).toBe(true);
  });
});

describe('normaliseDigits', () => {
  it('strips spaces and hyphens only', () => {
    expect(normaliseDigits('2345 6789-0124')).toBe('234567890124');
    expect(normaliseDigits('abc')).toBe('abc');
  });
});
