import { describe, expect, it, vi } from 'vitest';

import type { FieldDescriptor, MatchResult } from '@/shared/types';
import type { FieldKey } from '@/matching/taxonomy';
import type { DocumentOutcome } from './fill-service';
import type { MatchedSlot } from './harvest-service';

/**
 * The review's document section: every document the form asks for, beside
 * what the page actually holds. It replaced a stub that told the user to
 * "attach from the Documents panel", which no screen could do.
 */

vi.mock('./harvest-service', () => ({ harvestTab: vi.fn() }));
const { documentsFor } = await import('./review-service');

const PHOTO: FieldDescriptor = {
  ref: 'f2',
  selectors: ['#fuPhoto'],
  tag: 'file',
  type: 'file',
  labelText: 'Upload your recent passport size photo',
  requirementText: 'JPEG only, 20 KB to 50 KB',
  accept: '.jpg',
  nearbyText: '',
  required: true,
  frameId: 0,
  visible: true,
  enabled: true,
};

const matches: MatchResult[] = [
  { fieldRef: 'f2', key: 'doc.photo' as FieldKey, confidence: 0.84, rationale: 't', source: 'rule' },
];

const attachedPhoto: DocumentOutcome = {
  ref: 'f2',
  key: 'doc.photo',
  portalLabel: 'Upload your recent passport size photo',
  route: 'file-box',
  attached: true,
  requirement: 'JPEG, 20 KB–50 KB',
  variant: { mime: 'image/jpeg', bytes: 41_000, width: 413, height: 531, passedThrough: false },
};

const base = { fields: [PHOTO], matches, uploadSlots: [] as MatchedSlot[], uploadButtons: {} };

describe('documentsFor', () => {
  it('shows what went in beside what was asked, and offers the Upload button', () => {
    const [doc] = documentsFor(
      { ...base, uploadButtons: { f2: { selector: '#btnUploadPhoto', label: 'Upload' } } },
      new Map([['f2', 'file']]),
      [attachedPhoto],
      new Set(),
    );

    expect(doc).toEqual({
      ref: 'f2',
      key: 'doc.photo',
      portalLabel: 'Upload your recent passport size photo',
      route: 'file-box',
      requirement: 'JPEG, 20 KB–50 KB',
      variant: { mime: 'image/jpeg', bytes: 41_000, width: 413, height: 531 },
      attached: true,
      uploadButton: 'Upload',
      uploaded: false,
    });
  });

  it('believes the page over its own memory: an emptied box is not attached', () => {
    const [doc] = documentsFor(base, new Map([['f2', '']]), [attachedPhoto], new Set());
    expect(doc).toMatchObject({ attached: false, code: 'emptied' });
    expect(doc?.problem).toMatch(/emptied the box/);
  });

  it('says a document is already uploaded rather than asking for it again', () => {
    const [doc] = documentsFor(base, new Map([['f2', '']]), [attachedPhoto], new Set(['doc.photo' as FieldKey]));
    expect(doc).toMatchObject({ attached: false, uploaded: true, code: 'already-uploaded' });
  });

  it('reads the requirement off the page before any fill has run', () => {
    const [doc] = documentsFor(base, new Map(), [], new Set());
    expect(doc).toMatchObject({ requirement: 'JPEG, 20 KB–50 KB', variant: null, code: 'not-filled' });
  });

  it('passes on why a document could not be made', () => {
    const unmade: DocumentOutcome = {
      ref: 'f2',
      key: 'doc.photo',
      portalLabel: 'Upload your recent passport size photo',
      route: 'file-box',
      attached: false,
      requirement: 'JPEG, 20 KB–50 KB',
      code: 'no-master',
      reason: 'No doc.photo has been added to your vault yet.',
    };
    const [doc] = documentsFor(base, new Map([['f2', '']]), [unmade], new Set());
    expect(doc).toMatchObject({ code: 'no-master', problem: 'No doc.photo has been added to your vault yet.' });
  });

  it('explains an upload window, and says when a document is waiting in one', () => {
    const slot: MatchedSlot = {
      ref: 'u0',
      kind: 'window',
      label: 'Upload your PAN card copy',
      requirementText: 'Max 10 MB.',
      selectors: ['#add'],
      required: true,
      frameId: 0,
      key: 'doc.pan_card',
      confidence: 0.84,
      constraint: { mime: [], maxBytes: 10 * 1024 * 1024 },
    };
    const waiting = documentsFor({ ...base, fields: [], matches: [], uploadSlots: [slot] }, new Map(), [], new Set());
    expect(waiting[0]).toMatchObject({ route: 'window', attached: false, code: 'needs-window', requirement: '≤ 10 MB' });

    const placed = documentsFor(
      { ...base, fields: [], matches: [], uploadSlots: [slot] },
      new Map(),
      [{ ...attachedPhoto, ref: 'u0', key: 'doc.pan_card', route: 'window' }],
      new Set(),
    );
    expect(placed[0]).toMatchObject({ attached: true, code: 'press-upload-in-window' });
  });

  it('skips a question the matcher could not place', () => {
    const slot = { ref: 'u0', kind: 'window', label: 'Anything else?', requirementText: '', selectors: [], required: false, frameId: 0, key: null, confidence: 0, constraint: { mime: [] } } as MatchedSlot;
    expect(documentsFor({ ...base, fields: [], matches: [], uploadSlots: [slot] }, new Map(), [], new Set())).toEqual([]);
  });
});
