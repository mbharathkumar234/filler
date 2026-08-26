// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  blockerCleared,
  detectBlockers,
  findDraftControl,
  INSTRUCTIONS,
  looksLikeSessionExpiry,
  primaryBlocker,
} from './blockers';
import { harvest } from './harvester';

function page(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('finding the controls a human has to operate', () => {
  it('sees a reCAPTCHA iframe', () => {
    page('<iframe src="https://www.google.com/recaptcha/api2/anchor?k=abc"></iframe>');
    expect(detectBlockers()).toContainEqual(expect.objectContaining({ type: 'captcha' }));
  });

  it.each([
    ['hCaptcha', '<iframe src="https://newassets.hcaptcha.com/captcha/v1/frame"></iframe>'],
    ['Turnstile', '<iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js"></iframe>'],
    ['a vendor container', '<div class="g-recaptcha" data-sitekey="6Lc"></div>'],
    ['an Arkose frame', '<iframe src="https://client-api.arkoselabs.com/v2/"></iframe>'],
  ])('sees %s', (_name, html) => {
    page(html);
    expect(primaryBlocker(detectBlockers())?.type).toBe('captcha');
  });

  it('sees the image-based CAPTCHA that Indian portals actually ship', () => {
    page(`
      <img id="imgCaptcha" src="/Handler/Captcha.ashx" alt="captcha" />
      <input id="txtCaptcha" name="txtCaptchaCode" />
    `);
    const findings = detectBlockers();
    expect(findings.filter((f) => f.type === 'captcha').length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['name', '<input name="txtOTP" />'],
    ['id', '<input id="otpField" />'],
    ['the standards-track declaration', '<input autocomplete="one-time-code" />'],
    ['a placeholder', '<input placeholder="Enter One Time Password" />'],
    ['vcode, the ASP.NET convention', '<input name="vcode" />'],
    ['a spelled-out label', '<input aria-label="Verification Code" />'],
  ])('sees a one-time-code field by its %s', (_name, html) => {
    page(html);
    expect(primaryBlocker(detectBlockers())?.type).toBe('otp');
  });

  it('does not mistake ordinary fields for security controls', () => {
    page(`
      <input name="txtName" placeholder="Full Name" />
      <input name="pincode" placeholder="PIN Code" />
      <input name="captain_name" />
      <input name="promoCode" />
      <img id="logo" src="/logo.png" alt="State Emblem" />
    `);
    expect(detectBlockers()).toEqual([]);
  });

  it('does not find "otp" hiding inside an ordinary word', () => {
    // A bare /otp/ matches footprint and hotpoint. Tokenising is what stops a
    // land-area field from pausing the run forever.
    page(`
      <input name="footprintArea" />
      <input name="hotpointModel" />
      <input name="slotPosition" />
      <input name="depotPincode" />
    `);
    expect(detectBlockers()).toEqual([]);
  });

  it('sees a DigiLocker / eSign hand-off', () => {
    page('<a href="https://api.digilocker.gov.in/public/oauth2/1/authorize">Fetch from DigiLocker</a>');
    expect(primaryBlocker(detectBlockers())?.type).toBe('esign');
  });

  it('sees an eSign step announced only by its label', () => {
    page('<button id="btnSign">Proceed to e-Sign</button>');
    expect(primaryBlocker(detectBlockers())?.type).toBe('esign');
  });

  it.each(['razorpay.com', 'securegw.paytm.in', 'www.billdesk.com', 'api.ccavenue.com'])(
    'sees a payment gateway at %s',
    (host) => {
      page(`<form action="https://${host}/pay"><button>Continue</button></form>`);
      expect(primaryBlocker(detectBlockers())?.type).toBe('payment');
    },
  );

  it('ranks a payment above a CAPTCHA — it is the one we will never do', () => {
    page(`
      <div class="g-recaptcha" data-sitekey="6Lc"></div>
      <a href="https://razorpay.com/checkout">Pay now</a>
    `);
    expect(primaryBlocker(detectBlockers())?.type).toBe('payment');
  });

  it('reports each control once, however many ways it matched', () => {
    page('<input id="otp" name="otp" placeholder="OTP" autocomplete="one-time-code" />');
    expect(detectBlockers().filter((f) => f.type === 'otp')).toHaveLength(1);
  });
});

describe('P4 — this module notices controls, it never reads them', () => {
  /**
   * The point of these tests is not that the current code behaves; it is that
   * the next edit cannot quietly start reading a challenge. Two independent
   * checks: what the findings contain, and what the file is even capable of.
   */

  it('never returns anything the user typed into a one-time-code field', () => {
    const doc = page('<input id="otp" name="txtOTP" />');
    const input = doc.getElementById('otp') as HTMLInputElement;
    input.value = '483920';
    input.setAttribute('value', '483920');

    const serialised = JSON.stringify(detectBlockers());
    expect(serialised).not.toContain('483920');
  });

  it('never returns the content of a CAPTCHA image', () => {
    page(
      '<img id="imgCaptcha" alt="Type the letters XKCD42" src="data:image/png;base64,IAMTHECHALLENGE" />',
    );
    const serialised = JSON.stringify(detectBlockers());
    expect(serialised).not.toContain('XKCD42');
    expect(serialised).not.toContain('IAMTHECHALLENGE');
  });

  it('shows the user our words, never the page’s', () => {
    page('<div class="g-recaptcha" data-sitekey="6Lc">Solve this puzzle to continue, human</div>');
    for (const finding of detectBlockers()) {
      expect(Object.values(INSTRUCTIONS)).toContain(finding.instruction);
    }
  });

  it('cannot read a challenge, as a matter of source text', () => {
    // A hostile page cannot make this pass or fail — it inspects our own file.
    // If someone adds OCR, a canvas read, or a value lookup here, this breaks
    // before it ever reaches a user. See CLAUDE.md hard rule 3.
    const sources = import.meta.glob('./blockers.ts', { query: '?raw', eager: true }) as Record<
      string,
      { default: string }
    >;
    const source = Object.values(sources)[0]?.default ?? '';
    expect(source.length).toBeGreaterThan(500);

    const forbidden = [
      '.value',
      'createImageBitmap',
      'toDataURL',
      'getImageData',
      'OffscreenCanvas',
      'fetch(',
      'XMLHttpRequest',
      'tesseract',
      'recognize(',
      '.click()',
      'dispatchEvent',
    ];
    for (const token of forbidden) {
      expect(source, `blockers.ts must never contain ${token}`).not.toContain(token);
    }
  });

  it('the harvester refuses to describe these fields as fillable in the first place', () => {
    // Belt and braces: even if a blocker were missed, an OTP box is not a
    // field the fill engine is ever handed.
    const doc = page(`
      <label for="a">Full Name</label><input id="a" name="txtName" />
      <label for="b">Enter OTP</label><input id="b" name="txtOTP" />
      <label for="c">Enter Captcha</label><input id="c" name="txtCaptcha" />
      <input id="d" type="password" name="pwd" />
    `);
    const result = harvest(doc);
    const names = result.fields.map((f) => f.selectors[0] ?? '');

    expect(names).toContain('#a');
    expect(names).not.toContain('#b');
    expect(names).not.toContain('#c');
    expect(names).not.toContain('#d');
  });
});

describe('knowing when the user is finished', () => {
  it('reports the blocker as cleared once it is removed', () => {
    const doc = page('<div class="g-recaptcha" data-sitekey="6Lc"></div>');
    expect(blockerCleared('captcha', doc)).toBe(false);

    doc.querySelector('.g-recaptcha')?.remove();
    expect(blockerCleared('captcha', doc)).toBe(true);
  });

  it('reports it as cleared once it is merely hidden, which is what portals do', () => {
    const doc = page('<div id="cap" class="g-recaptcha" data-sitekey="6Lc"></div>');
    expect(blockerCleared('captcha', doc)).toBe(false);

    (doc.getElementById('cap') as HTMLElement).style.display = 'none';
    expect(blockerCleared('captcha', doc)).toBe(true);
  });

  it('does not confuse one kind of blocker for another', () => {
    const doc = page(`
      <div class="g-recaptcha" data-sitekey="6Lc"></div>
      <input name="txtOTP" />
    `);
    expect(blockerCleared('captcha', doc)).toBe(false);
    expect(blockerCleared('otp', doc)).toBe(false);

    doc.querySelector('.g-recaptcha')?.remove();
    expect(blockerCleared('captcha', doc)).toBe(true);
    expect(blockerCleared('otp', doc)).toBe(false);
  });
});

describe('session expiry and draft saves (§Phase 6 Should)', () => {
  it('recognises being bounced to a login page', () => {
    const doc = page('<input type="password" name="pwd" /><button>Login</button>');
    doc.title = 'Login | State Portal';
    expect(looksLikeSessionExpiry(doc)).toBe(true);
  });

  it('does not cry session-expiry over an ordinary form', () => {
    const doc = page('<input name="txtName" />');
    doc.title = 'Application Form';
    expect(looksLikeSessionExpiry(doc)).toBe(false);
  });

  it('finds the portal’s own Save as Draft, to be offered rather than pressed', () => {
    const doc = page('<button id="btnDraft">Save as Draft</button><button id="btnGo">Submit</button>');
    expect(findDraftControl(doc)).toEqual({ selector: '#btnDraft', label: 'Save as Draft' });
  });

  it('returns null when the portal has no draft facility', () => {
    expect(findDraftControl(page('<button id="btnGo">Submit</button>'))).toBeNull();
  });
});

describe('cross-origin frames report what they are, not what we fear (§ mutation-testing gap)', () => {
  it('calls an unreadable frame an unknown widget, never an OTP', () => {
    // The distinction matters for P4. Calling every unreadable frame an OTP
    // would put the OTP instruction in front of a user looking at a chat
    // widget, and instructions nobody needs are instructions people learn to
    // dismiss.
    page('<iframe src="https://widget.example.com/chat"></iframe>');
    const found = detectBlockers(document);
    expect(found).toHaveLength(1);
    expect(found[0]!.type).toBe('unknown_widget');
  });

  it('still calls a CAPTCHA frame a CAPTCHA', () => {
    page('<iframe src="https://www.google.com/recaptcha/api2/anchor?k=abc"></iframe>');
    expect(detectBlockers(document)[0]!.type).toBe('captcha');
  });

  it('never reports an OTP from a frame at all, whatever the frame says', () => {
    // We cannot read inside a cross-origin frame, so we cannot know. Guessing
    // "otp" from a URL would be the first step toward reading one.
    page(`
      <iframe src="https://otp.example.com/enter-otp" title="Enter OTP"></iframe>
      <iframe src="https://bank.example.com/verify?otp=1" title="one time password"></iframe>
    `);
    for (const blocker of detectBlockers(document)) {
      expect(blocker.type).not.toBe('otp');
    }
  });
});
