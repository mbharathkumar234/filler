// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetGuardForTests,
  arm,
  disarm,
  guardState,
  installSubmitGuard,
  isSubmitish,
  setToastHandler,
  submitWithApproval,
  type ApprovalToken,
} from './submit-guard';

/**
 * P2 is the promise the whole product rests on: nothing the extension filled
 * reaches a submit without an explicit approval gesture. These tests are the
 * evidence for that claim, so they are deliberately adversarial.
 */
function mount(html: string): void {
  document.body.innerHTML = html;
}

function token(overrides: Partial<ApprovalToken> = {}): ApprovalToken {
  return {
    value: 'deadbeefdeadbeefdeadbeefdeadbeef',
    expiresAt: Date.now() + 90_000,
    targetSelector: '#btnFinalSubmit',
    ...overrides,
  };
}

/**
 * jsdom implements a submit button's default action by calling
 * `HTMLFormElement.prototype.submit()` internally — a real browser does not; it
 * runs its own form-submission algorithm. Tests that let the default action
 * proceed therefore see one extra pass through the patched method that would
 * never happen in Chrome. Calling `preventDefault()` in a submit listener stops
 * the default action and models a real page, so keep these listeners.
 */
function cancelDefault() {
  return vi.fn((event: Event) => {
    event.preventDefault();
  });
}

const FORM = `
  <form id="frm" action="/submit">
    <input id="txt" name="txt">
    <textarea id="area"></textarea>
    <button type="button" id="btnDraft">Save Draft</button>
    <button type="submit" id="btnFinalSubmit">Final Submit</button>
  </form>
`;

beforeEach(() => {
  __resetGuardForTests();
  document.body.innerHTML = '';
});

describe('isSubmitish', () => {
  it.each([
    ['<button type="submit">Go</button>', true],
    ['<input type="submit" value="Go">', true],
    ['<input type="image" src="go.png">', true],
    ['<button>Untyped buttons default to submit</button>', true],
    ['<a href="javascript:__doPostBack(\'x\',\'\')">Next</a>', true],
    ['<button type="button">Save Draft</button>', false],
    ['<input type="text">', false],
    ['<div>Not a button</div>', false],
  ])('classifies %s as %s', (html, expected) => {
    mount(html);
    expect(isSubmitish(document.body.firstElementChild)).toBe(expected);
  });

  it('recognises a submit by its text even when typed as a button', () => {
    mount('<button type="button">Final Submit</button>');
    expect(isSubmitish(document.body.firstElementChild)).toBe(true);
  });

  it('handles a null target', () => {
    expect(isSubmitish(null)).toBe(false);
  });
});

describe('blocking while unarmed', () => {
  beforeEach(() => {
    mount(FORM);
    installSubmitGuard(document);
  });

  it('blocks a click on the submit button', () => {
    const submitted = vi.fn();
    document.querySelector('#frm')!.addEventListener('submit', submitted);

    document.querySelector<HTMLElement>('#btnFinalSubmit')!.click();

    expect(submitted).not.toHaveBeenCalled();
    expect(guardState().blocked).toBe(1);
  });

  it('blocks a submit event raised by the page', () => {
    const handler = vi.fn();
    document.querySelector('#frm')!.addEventListener('submit', handler);

    document
      .querySelector('#frm')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(handler).not.toHaveBeenCalled();
    expect(guardState().blocked).toBe(1);
  });

  it('blocks Enter pressed inside a form field', () => {
    const input = document.querySelector('#txt')!;
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(guardState().blocked).toBe(1);
  });

  it('lets Enter through in a textarea, where it means a newline', () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    document.querySelector('#area')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not interfere with a non-submit button', () => {
    const clicked = vi.fn();
    document.querySelector('#btnDraft')!.addEventListener('click', clicked);
    document.querySelector<HTMLElement>('#btnDraft')!.click();
    expect(clicked).toHaveBeenCalled();
  });

  it('shows a toast so the block is never mysterious', () => {
    const toast = vi.fn();
    setToastHandler(toast);
    document.querySelector<HTMLElement>('#btnFinalSubmit')!.click();

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]?.[0]).toMatch(/blocked/i);
    expect(toast.mock.calls[0]?.[0]).toMatch(/review/i);
  });

  it('counts every block, for the audit log', () => {
    document.querySelector<HTMLElement>('#btnFinalSubmit')!.click();
    document.querySelector<HTMLElement>('#btnFinalSubmit')!.click();
    expect(guardState().blocked).toBe(2);
  });
});

describe('the adversarial case: form.submit() from page script', () => {
  beforeEach(() => {
    mount(FORM);
    installSubmitGuard(document);
  });

  it('blocks a scripted form.submit() while unarmed', () => {
    const toast = vi.fn();
    setToastHandler(toast);

    // The patched method must not reach the native one; the toast and the
    // counter are the observable evidence that it was intercepted.
    document.querySelector<HTMLFormElement>('#frm')!.submit();

    expect(guardState().blocked).toBe(1);
    expect(toast.mock.calls[0]?.[0]).toMatch(/script on this page/i);
  });

  it('is idempotent — installing twice does not double-patch', () => {
    installSubmitGuard(document);
    installSubmitGuard(document);
    document.querySelector<HTMLFormElement>('#frm')!.submit();
    expect(guardState().blocked).toBe(1);
  });
});

describe('arming', () => {
  beforeEach(() => {
    mount(FORM);
    installSubmitGuard(document);
  });

  it('permits exactly the element the token names', () => {
    const submitted = cancelDefault();
    document.querySelector('#frm')!.addEventListener('submit', submitted);

    arm(token());
    document.querySelector<HTMLElement>('#btnFinalSubmit')!.click();

    // The submission reached the page's own handler — nothing was blocked.
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(guardState().blocked).toBe(0);
  });

  it('burns the token, so a second click is blocked', () => {
    const submitted = cancelDefault();
    document.querySelector('#frm')!.addEventListener('submit', submitted);

    arm(token());
    document.querySelector<HTMLElement>('#btnFinalSubmit')!.click();
    document.querySelector<HTMLElement>('#btnFinalSubmit')!.click();

    expect(submitted).toHaveBeenCalledTimes(1);
    expect(guardState().blocked).toBe(1);
    expect(guardState().armed).toBeNull();
  });

  it('refuses an expired token', () => {
    arm(token({ expiresAt: Date.now() - 1 }));
    document.querySelector<HTMLElement>('#btnFinalSubmit')!.click();
    expect(guardState().blocked).toBe(1);
  });

  it('does not authorise a different control', () => {
    // Approval for "Final Submit" must not authorise anything else.
    mount(`
      <form id="frm">
        <button type="submit" id="btnFinalSubmit">Final Submit</button>
        <button type="submit" id="btnWithdraw">Withdraw Application</button>
      </form>
    `);
    __resetGuardForTests();
    installSubmitGuard(document);

    arm(token());
    document.querySelector<HTMLElement>('#btnWithdraw')!.click();

    expect(guardState().blocked).toBe(1);
    // The token survives, because it was never spent on the wrong control.
    expect(guardState().armed).not.toBeNull();
  });

  it('disarms on request', () => {
    arm(token());
    disarm();
    document.querySelector<HTMLElement>('#btnFinalSubmit')!.click();
    expect(guardState().blocked).toBe(1);
  });

  it('permits one scripted submit while armed, then blocks', () => {
    arm(token());
    const form = document.querySelector<HTMLFormElement>('#frm')!;
    form.submit();
    expect(guardState().blocked).toBe(0);

    form.submit();
    expect(guardState().blocked).toBe(1);
  });
});

describe('submitWithApproval', () => {
  beforeEach(() => {
    mount(FORM);
    installSubmitGuard(document);
  });

  it('clicks exactly the recorded element', () => {
    document.querySelector('#frm')!.addEventListener('submit', cancelDefault());
    const clicked = vi.fn();
    document.querySelector('#btnFinalSubmit')!.addEventListener('click', clicked);

    const approval = token();
    arm(approval);
    expect(submitWithApproval(approval, document)).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('leaves no live token behind afterwards', () => {
    document.querySelector('#frm')!.addEventListener('submit', cancelDefault());
    const approval = token();
    arm(approval);
    submitWithApproval(approval, document);
    expect(guardState().armed).toBeNull();
  });

  it('refuses a token that was never armed', () => {
    expect(submitWithApproval(token(), document)).toBe(false);
  });

  /**
   * § COMPLETION_PLAN Phase B — "leaves no armed state behind".
   *
   * Every early return used to leave `state.armed` set. The narrow but real
   * consequence: the element goes missing (a postback re-rendering the form),
   * we bail out, and the guard stays armed for the rest of the ninety seconds.
   * If the element then comes *back* with the same selector, a page-initiated
   * click on it would be permitted — an activation nobody approved.
   */
  it('disarms when the recorded element is not on the page', () => {
    const approval = token({ targetSelector: '#doesNotExist' });
    arm(approval);

    expect(submitWithApproval(approval, document)).toBe(false);
    expect(guardState().armed).toBeNull();
  });

  it('does not permit a page click once the missing element comes back', () => {
    // The postback case, end to end: bail out, element reappears, page clicks.
    const approval = token({ targetSelector: '#btnLater' });
    arm(approval);
    expect(submitWithApproval(approval, document)).toBe(false);

    const button = document.createElement('button');
    button.id = 'btnLater';
    button.type = 'submit';
    document.querySelector('#frm')!.append(button);

    const before = guardState().blocked;
    button.click();

    expect(guardState().blocked).toBeGreaterThan(before);
  });

  it('disarms when the token does not match the armed one', () => {
    arm(token({ value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));
    submitWithApproval(token({ value: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), document);
    expect(guardState().armed).toBeNull();
  });

  it('disarms an expired token rather than leaving it to linger', () => {
    const approval = token({ expiresAt: Date.now() - 1 });
    arm(approval);

    expect(submitWithApproval(approval, document)).toBe(false);
    expect(guardState().armed).toBeNull();
  });

  it('refuses a token that does not match the armed one', () => {
    arm(token({ value: 'aaaa' }));
    expect(submitWithApproval(token({ value: 'bbbb' }), document)).toBe(false);
  });

  it('refuses an expired token', () => {
    const expired = token({ expiresAt: Date.now() - 1 });
    arm(expired);
    expect(submitWithApproval(expired, document)).toBe(false);
  });

  it('refuses when the recorded element is gone from the page', () => {
    const approval = token({ targetSelector: '#no-such-button' });
    arm(approval);
    expect(submitWithApproval(approval, document)).toBe(false);
  });
});
