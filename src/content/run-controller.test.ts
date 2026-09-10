// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunController, type ControllerPorts } from './run-controller';
import { resolveRanked } from './reverify';
import { INSTRUCTIONS } from './blockers';
import { setRunStorage, type RunStorage } from '@/runtime/persistence';
import type { FieldKey } from '@/matching/taxonomy';
import type { FillPlan } from '@/shared/types';

/**
 * The controller, in isolation.
 *
 * The e2e suite drives this same class against a real browser and a fixture
 * that misbehaves like a portal (`tests/e2e/resume.spec.ts`). These tests are
 * the fast, precise half: they can put the page in a state that is awkward to
 * reach on purpose — a field whose selectors have all died, a blocker that
 * appears halfway through — and assert the exact transition.
 */

function fakeStorage(): RunStorage {
  const items = new Map<string, unknown>();
  return {
    get(keys) {
      if (keys === null) return Promise.resolve(Object.fromEntries(items));
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) if (items.has(key)) out[key] = items.get(key);
      return Promise.resolve(out);
    },
    set(entries) {
      for (const [key, value] of Object.entries(entries)) items.set(key, value);
      return Promise.resolve();
    },
    remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) items.delete(key);
      return Promise.resolve();
    },
  };
}

const FORM = `
  <form>
    <label for="n">Candidate Name</label><input id="n" name="txtName" />
    <label for="e">Email ID</label><input id="e" name="txtEmail" />
  </form>
`;

function plan(): FillPlan {
  return {
    siteId: 'test',
    profileVersion: null,
    formFingerprint: 'fp-1',
    tabId: 1,
    fields: [
      {
        fieldRef: 'txtName',
        key: 'identity.full_name' as FieldKey,
        selectors: ['#n', 'input[name="txtName"]'],
        confidence: 0.95,
        source: 'rule',
      },
      {
        fieldRef: 'txtEmail',
        key: 'contact.email' as FieldKey,
        selectors: ['#e', 'input[name="txtEmail"]'],
        confidence: 0.95,
        source: 'rule',
      },
    ],
    documents: [],
    submit: { selectors: ['#go'], label: 'Submit' },
    createdAt: Date.now(),
  };
}

interface Harness {
  controller: RunController;
  refills: string[][];
  pauses: string[];
  resumes: number;
}

function build(overrides: Partial<ControllerPorts> = {}): Harness {
  const refills: string[][] = [];
  const pauses: string[] = [];
  let resumes = 0;

  const controller = new RunController({
    tabId: 1,
    doc: document,
    resolve: (ref) => {
      const field = plan().fields.find((f) => f.fieldRef === ref);
      return field ? (resolveRanked(field.selectors, document)?.el ?? null) : null;
    },
    requestRefill: (refs) => {
      refills.push(refs);
      return Promise.resolve({ ok: true });
    },
    onPause: (finding) => pauses.push(finding.type),
    onResume: () => {
      resumes += 1;
    },
    ...overrides,
  });

  live.push(controller);

  return {
    controller,
    refills,
    pauses,
    get resumes() {
      return resumes;
    },
  };
}

/**
 * Every controller built in this file, so the watcher is always torn down.
 *
 * Without this a test that fails before its own `detach()` leaves a live
 * MutationObserver behind, which then fires against a destroyed jsdom and
 * reports an unrelated error over the top of the real failure.
 */
const live: RunController[] = [];

function setValue(id: string, value: string): void {
  (document.getElementById(id) as HTMLInputElement).value = value;
}

let counter = 0;

afterEach(() => {
  for (const controller of live.splice(0)) controller.detach();
});

beforeEach(() => {
  setRunStorage(fakeStorage());
  document.body.innerHTML = FORM;
  counter += 1;
});

/** A fingerprint unique per test, so runs never bleed between them. */
function fingerprint(): string {
  return `fp-${counter}`;
}

describe('starting a run on a clean page', () => {
  it('reaches FILLING and permits writes', async () => {
    const { controller } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());

    expect(await controller.beginFill()).toBe(true);
    expect(controller.state.t).toBe('FILLING');
    controller.detach();
  });

  it('goes to REVIEW when the fill is done', async () => {
    const { controller } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();
    await controller.toReview();

    expect(controller.state.t).toBe('REVIEW');
    controller.detach();
  });
});

describe('a page with a human-only step', () => {
  beforeEach(() => {
    document.body.innerHTML = `${FORM}<div class="g-recaptcha" data-sitekey="x"></div>`;
  });

  it('refuses to begin filling at all', async () => {
    const { controller, pauses } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());

    expect(await controller.beginFill()).toBe(false);
    expect(controller.state.t).toBe('BLOCKED');
    expect(pauses).toEqual(['captcha']);
    controller.detach();
  });

  it('shows our instruction, from the frozen table', async () => {
    const { controller } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();

    expect(controller.blocker?.instruction).toBe(INSTRUCTIONS.captcha);
    controller.detach();
  });

  it('does not resume on the user’s word alone while the gate is still up', async () => {
    const { controller, refills } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();

    await controller.userContinue();

    // Straight back to BLOCKED: re-verification found the CAPTCHA still there.
    expect(controller.state.t).toBe('BLOCKED');
    expect(refills).toEqual([]);
    controller.detach();
  });

  it('resumes once the user has actually cleared it', async () => {
    const { controller, refills } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();

    document.querySelector('.g-recaptcha')?.remove();
    await controller.userContinue();

    // Nothing was ever written, so every field needs filling.
    expect(refills).toEqual([['txtName', 'txtEmail']]);
    controller.detach();
  });

  it('blocks mid-run when the gate appears after filling started', async () => {
    document.body.innerHTML = FORM;
    const { controller } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();
    expect(controller.state.t).toBe('FILLING');

    // The portal reveals an OTP box after the first few fields.
    document.body.insertAdjacentHTML('beforeend', '<input name="txtOTP" />');
    expect(await controller.checkBlockers()).toBe(true);
    expect(controller.state).toMatchObject({ t: 'BLOCKED', reason: 'otp' });
    expect(controller.halted).toBe(true);
    controller.detach();
  });
});

describe('re-verifying after the page changes', () => {
  it('asks for a refill of exactly what was reset', async () => {
    const { controller, refills } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();

    setValue('n', 'Ravi Kumar');
    setValue('e', 'ravi@example.com');
    controller.remember(['txtName', 'txtEmail']);

    // The postback empties one of them.
    setValue('e', '');
    await controller.reverifyNow();

    expect(refills).toEqual([['txtEmail']]);
    controller.detach();
  });

  it('goes to REVIEW, asking for nothing, when everything survived', async () => {
    const { controller, refills } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();

    setValue('n', 'Ravi Kumar');
    setValue('e', 'ravi@example.com');
    controller.remember(['txtName', 'txtEmail']);

    await controller.reverifyNow();

    expect(refills).toEqual([]);
    expect(controller.state.t).toBe('REVIEW');
    controller.detach();
  });

  it('does not treat the page tidying a value as a reset', async () => {
    const { controller, refills } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();

    setValue('n', 'Ravi Kumar');
    controller.remember(['txtName']);
    // The portal trims and upper-cases on blur, as portals do.
    setValue('n', '  RAVI KUMAR ');

    await controller.reverifyNow();
    expect(refills.flat()).not.toContain('txtName');
    controller.detach();
  });

  it('survives the ids being regenerated, via the name selector', async () => {
    const { controller, refills } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();

    setValue('n', 'Ravi Kumar');
    setValue('e', 'ravi@example.com');
    controller.remember(['txtName', 'txtEmail']);

    // The postback: new ids, values wiped, names intact.
    document.getElementById('n')!.id = 'ctl99_n';
    document.getElementById('e')!.id = 'ctl99_e';
    for (const input of document.querySelectorAll('input')) input.value = '';

    await controller.reverifyNow();

    // Found and flagged for refill — not lost.
    expect(refills).toEqual([['txtName', 'txtEmail']]);
    expect(controller.state.t).not.toBe('DRIFTED');
    controller.detach();
  });

  it('escalates to DRIFTED when a field is gone entirely', async () => {
    const { controller, refills } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();

    document.getElementById('e')?.remove();
    await controller.reverifyNow();

    expect(controller.state).toMatchObject({ t: 'DRIFTED', lost: ['txtEmail'] });
    // And crucially: it did not quietly refill the survivors and call it done.
    expect(refills).toEqual([]);
    controller.detach();
  });

  it('reports a failed refill instead of pretending it worked', async () => {
    const status: string[] = [];
    const { controller } = build({
      requestRefill: () => Promise.resolve({ ok: false, error: 'Vault is locked.' }),
      onStatus: (_status, detail) => status.push(detail ?? ''),
    });
    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();

    await controller.reverifyNow();

    expect(status).toContain('Vault is locked.');
    controller.detach();
  });
});

describe('the run survives the document', () => {
  it('comes back from storage and re-verifies, rather than trusting itself', async () => {
    const storage = fakeStorage();
    setRunStorage(storage);
    const fp = fingerprint();

    const first = build();
    await first.controller.attach(fp);
    await first.controller.setPlan(plan());
    await first.controller.beginFill();
    setValue('n', 'Ravi Kumar');
    setValue('e', 'ravi@example.com');
    first.controller.remember(['txtName', 'txtEmail']);
    await first.controller.toReview();
    first.controller.detach();

    // A postback. New document, empty fields, no in-memory expectations.
    document.body.innerHTML = FORM;

    const second = build({ reloaded: true });
    await second.controller.attach(fp);

    // The run was restored, forced into re-verification by the reload, found
    // the fields empty, and asked for them back.
    expect(second.refills).toEqual([['txtName', 'txtEmail']]);
    second.controller.detach();
  });

  it('an aborted run stops watching and cannot be written to', async () => {
    const { controller } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();

    await controller.abort('user pressed Abort');

    expect(controller.state).toEqual({ t: 'ABORTED', why: 'user pressed Abort' });
    expect(await controller.beginFill()).toBe(false);
  });
});

describe('without a run attached', () => {
  it('lets a Phase 5 style fill through unchanged', async () => {
    const { controller } = build();
    // No attach(): the controller has no store, so it does not stand in the
    // way of the older, simpler path.
    expect(await controller.beginFill()).toBe(true);
  });

  it('refuses to invent one', async () => {
    const { controller } = build();
    await expect(controller.userContinue()).rejects.toThrow(/No run attached/);
  });
});

describe('what the panel is told', () => {
  it('sees every transition', async () => {
    const seen: string[] = [];
    const { controller } = build({ onState: (state) => seen.push(state.t) });

    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();

    expect(seen).toEqual(['DETECTING', 'PLANNING', 'READY', 'FILLING']);
    controller.detach();
  });

  it('is not spammed by events the machine refused', async () => {
    const onState = vi.fn();
    const { controller } = build({ onState });

    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    const before = onState.mock.calls.length;

    // READY does not accept these; nothing should be announced.
    await controller.userContinue();
    await controller.userContinue();

    expect(onState.mock.calls.length).toBe(before);
    controller.detach();
  });
});

/**
 * The gap that let a wiring bug ship.
 *
 * Every test above hands the controller a plan before filling, because that is
 * the documented sequence. Production did not: `adoptRun` called `attach` and
 * nothing ever called `setPlan`, so the reducer sat in IDLE, ignored
 * `FILL_START`, and refused every write on every page — reported to the user
 * as "this page is waiting for you", which pointed the blame at the portal.
 *
 * These pin the sequence itself rather than the steps, so the same omission
 * cannot pass again.
 */
describe('a run that was never given a plan', () => {
  it('refuses to write, because IDLE is not READY', async () => {
    const { controller } = build();
    await controller.attach(fingerprint());

    expect(controller.state.t).toBe('IDLE');
    expect(await controller.beginFill()).toBe(false);
    expect(controller.state.t).toBe('IDLE');
    controller.detach();
  });

  it('reports no blocker, so the refusal is not the page\'s fault', async () => {
    const { controller, pauses } = build();
    await controller.attach(fingerprint());
    await controller.beginFill();

    // The distinction the user-facing message now depends on.
    expect(controller.blocker).toBeNull();
    expect(pauses).toEqual([]);
    controller.detach();
  });

  it('writes as soon as it is given one', async () => {
    const { controller } = build();
    await controller.attach(fingerprint());

    expect(await controller.beginFill()).toBe(false);
    await controller.setPlan(plan());
    expect(await controller.beginFill()).toBe(true);
    expect(controller.state.t).toBe('FILLING');
    controller.detach();
  });

  it('accepts a plan on a run already under way, for refills', async () => {
    // A postback refill arrives with no plan and must not restart the run.
    const { controller } = build();
    await controller.attach(fingerprint());
    await controller.setPlan(plan());
    await controller.beginFill();

    expect(await controller.beginFill()).toBe(true);
    expect(controller.state.t).toBe('FILLING');
    controller.detach();
  });
});
