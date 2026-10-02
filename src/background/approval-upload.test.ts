import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FieldDescriptor, MatchResult } from '@/shared/types';
import type { FieldKey } from '@/matching/taxonomy';

/**
 * One document's upload: a hold, then that document's Upload button, once.
 *
 * The final submit's approval is tested in `approval-service.test.ts`. This
 * one shares its registry and its guard, so what is tested here is only what
 * is new: which element an upload approval may name, what refuses it, and that
 * the run carries on afterwards.
 */

const PHOTO: FieldDescriptor = {
  ref: 'f2',
  selectors: ['#fuPhoto'],
  tag: 'file',
  type: 'file',
  labelText: 'Upload your recent passport size photo',
  nearbyText: '',
  required: true,
  frameId: 0,
  visible: true,
  enabled: true,
};

const page = {
  fields: [PHOTO],
  matches: [
    { fieldRef: 'f2', key: 'doc.photo' as FieldKey, confidence: 0.84, rationale: 'test', source: 'rule' },
  ] as MatchResult[],
  uploadButtons: { f2: { selector: '#btnUploadPhoto', label: 'Upload' } } as Record<
    string,
    { selector: string; label: string }
  >,
  blockers: [] as { type: string; reason: string; selector: string }[],
};

vi.mock('./harvest-service', () => ({
  harvestTab: async () => ({
    ok: true,
    data: {
      url: 'https://portal.example.gov.in/docs',
      fingerprint: 'fp-docs',
      fields: page.fields,
      matches: page.matches,
      uploadButtons: page.uploadButtons,
      blockers: page.blockers,
      frames: [{ frameId: 0, submit: { selector: '#btnFinal', label: 'Final Submit' } }],
    },
  }),
}));

const endRun = vi.fn();
vi.mock('./fill-service', () => ({ endRun: (id: number) => endRun(id) }));

/** What the file box holds right now, as the page reads it back. */
let held = 'file';
vi.mock('./review-service', () => ({
  forgetTabReview: vi.fn(),
  collectValues: async (_tabId: number, refs: string[]) => new Map(refs.map((ref) => [ref, held])),
}));

const audited: { event: { t: string } }[] = [];
vi.mock('@/runtime/audit', () => ({
  appendAudit: async (entry: { event: { t: string } }) => {
    audited.push(entry);
    return {};
  },
}));

interface Sent {
  type: string;
  ref?: string;
  token?: { value: string; targetSelector: string; expiresAt: number };
}
const sent: Sent[] = [];
let reply: () => Promise<unknown> = () => Promise.resolve({ ok: true, data: { pressed: true } });

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    sendMessage: (_tabId: number, message: { payload: Sent }) => {
      sent.push(message.payload);
      return reply();
    },
  },
};

const { uploadWithApproval, approvalStatus, __resetApprovalsForTests } = await import('./approval-service');
const { uploadedKeys, __resetUploadsForTests } = await import('./upload-state');

beforeEach(() => {
  __resetApprovalsForTests();
  __resetUploadsForTests();
  sent.length = 0;
  audited.length = 0;
  endRun.mockClear();
  held = 'file';
  page.uploadButtons = { f2: { selector: '#btnUploadPhoto', label: 'Upload' } };
  page.blockers = [];
  reply = () => Promise.resolve({ ok: true, data: { pressed: true } });
});

describe('uploadWithApproval', () => {
  it('presses exactly the Upload beside that file box, once, with a token', async () => {
    const result = await uploadWithApproval(7, 'f2');

    expect(result).toEqual({ ok: true, data: { pressed: true } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'fill:press-upload',
      ref: 'f2',
      token: { targetSelector: '#btnUploadPhoto' },
    });
    expect(sent[0]?.token?.value).toMatch(/^[0-9a-f]{32}$/);
  });

  it('burns the token before the press, so nothing is left armed', async () => {
    await uploadWithApproval(7, 'f2');
    expect(approvalStatus(7).active).toBe(false);
  });

  it('does not end the run — the next document may be next', async () => {
    await uploadWithApproval(7, 'f2');
    expect(endRun).not.toHaveBeenCalled();
    expect(uploadedKeys(7).has('doc.photo')).toBe(true);
  });

  it('records the approval and the press, by document, never by value', async () => {
    await uploadWithApproval(7, 'f2');
    expect(audited.map((entry) => entry.event.t)).toEqual(['upload.approved', 'upload.done']);
  });

  it('refuses a box with nothing in it, and presses nothing', async () => {
    held = '';
    const result = await uploadWithApproval(7, 'f2');
    expect(result.ok && result.data).toMatchObject({ pressed: false });
    expect(result.ok && result.data.why).toMatch(/no document in that box/i);
    expect(sent).toEqual([]);
  });

  it('refuses while a CAPTCHA is outstanding (P4)', async () => {
    page.blockers = [{ type: 'captcha', reason: 'A CAPTCHA widget is on this page.', selector: '#c' }];
    const result = await uploadWithApproval(7, 'f2');
    expect(result.ok && result.data.pressed).toBe(false);
    expect(sent).toEqual([]);
  });

  it('refuses a box with no Upload button of its own', async () => {
    page.uploadButtons = {};
    const result = await uploadWithApproval(7, 'f2');
    expect(result.ok && result.data.pressed).toBe(false);
    expect(sent).toEqual([]);
  });

  it('refuses to name anything the harvest did not record, whatever the panel asks for', async () => {
    // The panel names a ref. A ref that is not a document's file box — the
    // final submit's row, a made-up one — gets nothing pressed.
    for (const ref of ['f-final', 'btnFinal', '#btnFinal']) {
      const result = await uploadWithApproval(7, ref);
      expect(result.ok && result.data.pressed).toBe(false);
    }
    expect(sent).toEqual([]);
  });

  it('does not upload the same document twice in one run', async () => {
    await uploadWithApproval(7, 'f2');
    sent.length = 0;

    const again = await uploadWithApproval(7, 'f2');

    expect(again.ok && again.data.pressed).toBe(false);
    expect(sent).toEqual([]);
  });

  it('reads a page that posted back mid-answer as pressed — that is what Upload does', async () => {
    reply = () => Promise.reject(new Error('The message port closed before a response was received.'));
    const result = await uploadWithApproval(7, 'f2');
    expect(result).toEqual({ ok: true, data: { pressed: true, reloading: true } });
  });

  it('reads a page nobody was listening on as not pressed', async () => {
    reply = () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    const result = await uploadWithApproval(7, 'f2');
    expect(result.ok && result.data.pressed).toBe(false);
    expect(uploadedKeys(7).has('doc.photo')).toBe(false);
  });
});
