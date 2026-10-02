// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { harvest } from '@/content/harvester';
import { findUploadSlots } from '@/content/upload-slots';
import type { FieldDescriptor } from '@/shared/types';
import { CONFIDENCE } from '@/shared/types';
import { bandOf, matchField, matchForm } from './deterministic';

/**
 * Document questions, matched from a fixture (CLAUDE.md rule 5).
 *
 * Two pages from `fixtures/documents-portal/`. `page-1.html` asks through file
 * boxes in the shapes portals use; `google-style.html` asks through "Add file"
 * buttons with no box at all. Each question carries its expected key in
 * `data-expect`, so the wording — "passport size photo", "Aadhaar card copy",
 * "10th marks card" — is tested as the page says it, not as a synonym list
 * would like it said.
 */

const PAGES = import.meta.glob('../../fixtures/documents-portal/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function load(name: string): void {
  const html = Object.entries(PAGES).find(([path]) => path.endsWith(`/${name}`))?.[1];
  if (!html) throw new Error(`fixture ${name} is missing`);
  document.head.innerHTML = '';
  for (const style of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const el = document.createElement('style');
    el.textContent = style[1] ?? '';
    document.head.append(el);
  }
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('file boxes, as portals label them', () => {
  function scored() {
    load('page-1.html');
    const result = harvest(document);
    const matches = matchForm(result.fields);
    return result.fields.map((field, index) => ({
      label: field.labelText,
      expected: result.elements.get(field.ref)?.getAttribute('data-expect') ?? 'unannotated',
      match: matches[index]!,
    }));
  }

  it('annotates every box it tests', () => {
    expect(scored().every((s) => s.expected !== 'unannotated')).toBe(true);
  });

  it.each([
    ['doc.photo'],
    ['doc.signature'],
    ['doc.aadhaar_card'],
    ['doc.pan_card'],
    ['doc.marksheet_10'],
    ['doc.marksheet_12'],
  ])('finds %s, confidently enough to attach', (key) => {
    const found = scored().find((s) => s.expected === key);
    expect(found, `no box annotated ${key}`).toBeDefined();
    expect(found!.match.key, `"${found!.label}" → ${found!.match.rationale}`).toBe(key);
    expect(bandOf(found!.match)).not.toBe('unmapped');
  });

  it('names a box behind a "Choose file" label after its question, not its button', () => {
    const aadhaar = scored().find((s) => s.expected === 'doc.aadhaar_card');
    expect(aadhaar?.label).toBe('Upload your Aadhaar card copy');
  });

  it('leaves the traps unmapped', () => {
    for (const trap of scored().filter((s) => s.expected === 'unknown')) {
      expect(bandOf(trap.match), `"${trap.label}" became ${trap.match.key}`).toBe('unmapped');
    }
  });

  it('never names Dropzone’s stray input after the text that happens to precede it', () => {
    // It sits after the whole form. Named after that text, it could be given
    // any document at all — so it must stay nameless.
    const stray = scored().find(
      (s) => s.label === '' || (s.expected === 'unknown' && s.match.key === 'unknown'),
    );
    expect(stray).toBeDefined();
    load('page-1.html');
    const result = harvest(document);
    const input = [...result.elements].find(([, el]) => el.id === 'degree-input');
    const descriptor = result.fields.find((f) => f.ref === input?.[0]);
    expect(descriptor?.labelText).toBe('');
  });

  it('makes no confident mistake on any box', () => {
    for (const s of scored()) {
      if (s.match.confidence < CONFIDENCE.AUTO_FILL || s.match.key === 'unknown') continue;
      expect(s.match.key, `"${s.label}"`).toBe(s.expected);
    }
  });
});

describe('upload buttons with no box, as Google Forms asks', () => {
  /** An upload question matched the way the worker matches one (`matchSlot`). */
  function asFileField(ref: string, label: string): FieldDescriptor {
    return {
      ref,
      selectors: [],
      tag: 'file',
      type: 'file',
      labelText: label,
      nearbyText: '',
      required: false,
      frameId: 0,
      visible: true,
      enabled: true,
    };
  }

  it.each([
    ['add-photo', 'doc.photo'],
    ['add-aadhaar', 'doc.aadhaar_card'],
    ['add-pan', 'doc.pan_card'],
    ['add-marks10', 'doc.marksheet_10'],
  ])('reads the question behind #%s as %s', (id, key) => {
    load('google-style.html');
    const { slots, elements } = findUploadSlots(document, () => true);
    const slot = slots.find((s) => elements.get(s.ref)?.id === id);
    expect(slot, `no upload question found for #${id}`).toBeDefined();
    expect(elements.get(slot!.ref)?.getAttribute('data-expect')).toBe(key);

    const match = matchField(asFileField(slot!.ref, slot!.label));
    expect(match.key, `"${slot!.label}" → ${match.rationale}`).toBe(key);
    expect(bandOf(match)).not.toBe('unmapped');
  });

  it('never reads an upload question as the number it names', () => {
    // "Aadhaar card copy" is a document. Matched as a file field, the traits
    // veto rules out id.aadhaar, which is a 12-digit number.
    const match = matchField(asFileField('u0', 'Upload your Aadhaar card copy'));
    expect(match.key).not.toBe('id.aadhaar');
  });
});

/**
 * The folders a Karnataka student actually keeps (§ vault structure).
 *
 * `student-documents.html` asks for one document per folder, in the words the
 * boards, KEA and college portals use. Two questions in it are numbers printed
 * on a certificate rather than files — the RD numbers — and they are here for
 * the same reason: the folder holds them, so the vault must too.
 */
describe('a student’s own document set, as portals ask for it', () => {
  function scored() {
    load('student-documents.html');
    const result = harvest(document);
    const matches = matchForm(result.fields);
    return result.fields.map((field, index) => ({
      label: field.labelText,
      expected: result.elements.get(field.ref)?.getAttribute('data-expect') ?? 'unannotated',
      match: matches[index]!,
    }));
  }

  it('annotates every box it tests', () => {
    expect(scored().every((s) => s.expected !== 'unannotated')).toBe(true);
  });

  it.each([
    // Identity
    ['doc.voter_id'],
    ['doc.birth_certificate'],
    ['doc.passport'],
    ['doc.driving_licence'],
    // Class 10 — the same certificate exists at two levels, and the label says which
    ['doc.passing_certificate_10'],
    ['doc.study_certificate_10'],
    ['doc.transfer_certificate_10'],
    ['doc.migration_certificate_10'],
    // PUC
    ['doc.marksheet_11'],
    ['doc.marksheet_12'],
    ['doc.study_certificate_12'],
    ['doc.transfer_certificate_12'],
    ['doc.conduct_certificate'],
    // Caste and reservation, including the numbers printed on the certificates
    ['doc.caste_certificate'],
    ['eligibility.caste_certificate_number'],
    ['doc.income_certificate'],
    ['eligibility.income_certificate_number'],
    // Article 371(J)
    ['doc.article_371j_certificate'],
    ['eligibility.article_371j_number'],
    // KCET / KEA
    ['doc.entrance_application_form'],
    ['doc.entrance_fee_receipt'],
    ['doc.entrance_admission_ticket'],
    ['doc.entrance_result'],
    ['doc.entrance_rank_card'],
    ['doc.entrance_verification_slip'],
    ['doc.entrance_claim_verification'],
    ['doc.entrance_option_entry'],
    ['doc.seat_allotment_letter'],
    ['doc.admission_fee_receipt'],
    ['doc.admission_order'],
    // Photographs and signature
    ['doc.photo'],
    ['doc.signature'],
    ['doc.thumb_impression'],
    // Financial and scholarship
    ['doc.bank_passbook'],
    ['doc.scholarship_application'],
    // The course being read for now, and the papers it issues
    ['doc.semester_marksheet'],
    ['doc.consolidated_marksheet'],
    ['doc.bonafide_certificate'],
    ['doc.college_id_card'],
    ['doc.admission_letter'],
    ['education[].semester'],
    ['education[].year_of_study'],
    // The entrance exam, as numbers rather than papers
    ['entrance.exam_name'],
    ['entrance.registration_number'],
    ['entrance.rank'],
    ['entrance.score'],
    ['entrance.year'],
    // Reservation, per category
    ['doc.caste_certificate_form_d'],
    ['doc.ews_certificate'],
    ['doc.obc_certificate'],
    ['eligibility.article_371j'],
    // Work and skills
    ['doc.resume'],
    ['doc.internship_offer_letter'],
    ['doc.internship_certificate'],
    ['doc.experience_certificate'],
    ['doc.recommendation_letter'],
    ['doc.course_certificate'],
    ['doc.training_certificate'],
    ['doc.workshop_certificate'],
    ['doc.professional_certification'],
    // Achievements and projects
    ['doc.hackathon_certificate'],
    ['doc.competition_certificate'],
    ['doc.achievement_certificate'],
    ['doc.project_report'],
    ['doc.project_certificate'],
    ['doc.publication'],
    ['doc.patent_document'],
    // Sports and service
    ['doc.sports_certificate'],
    ['doc.ncc_certificate'],
    ['doc.nss_certificate'],
    ['doc.volunteering_certificate'],
    // The route that is not PUC
    ['doc.iti_marksheet'],
    ['doc.iti_certificate'],
  ])('finds %s', (key) => {
    const found = scored().find((s) => s.expected === key);
    expect(found, `no question annotated ${key}`).toBeDefined();
    expect(found!.match.key, `"${found!.label}" → ${found!.match.rationale}`).toBe(key);
    expect(bandOf(found!.match)).not.toBe('unmapped');
  });

  it('leaves a catch-all box unnamed rather than guessing a document for it', () => {
    const trap = scored().find((s) => s.expected === 'unknown');
    expect(bandOf(trap!.match), `"${trap!.label}" became ${trap!.match.key}`).toBe('unmapped');
  });

  it('makes no confident mistake on any question', () => {
    for (const s of scored()) {
      if (s.match.confidence < CONFIDENCE.AUTO_FILL || s.match.key === 'unknown') continue;
      expect(s.match.key, `"${s.label}"`).toBe(s.expected);
    }
  });
});
