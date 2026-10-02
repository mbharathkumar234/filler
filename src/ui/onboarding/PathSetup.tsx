/**
 * The questions the vault is built from (§ vault structure).
 *
 * Asked once, on one card, in the order a person lived them. Every answer is a
 * row of buttons rather than a dropdown, because the whole point is that the
 * options are readable at a glance — a person should be able to see that
 * "Diploma" is not their route without opening anything.
 *
 * Nothing here is required. **Skip** stores no path at all, which the panels
 * read as "show everything": the vault a user had before this screen existed.
 * A wrong answer costs a click, never a record — `vault-shape.ts` unions what
 * a path offers with everything already filled in.
 */

import { useState } from 'react';
import { branchesFor, coursesFor } from '@/matching/courses';
import {
  AFTER_TEN,
  BOARDS,
  CATEGORIES,
  CLAIMS,
  DEGREE_FAMILIES,
  ENTRANCE_EXAMS,
  STAGES,
  STREAMS,
  defaultPath,
  type AcademicPath,
  type Claim,
  type EntranceExam,
} from '@/matching/pathway';

interface Props {
  /** The path being edited, or null to start from the defaults. */
  path: AcademicPath | null;
  onSave: (path: AcademicPath) => void | Promise<void>;
  /** Store nothing, and show the whole catalogue. */
  onSkip: () => void | Promise<void>;
  onCancel?: () => void;
}

const BOARD_LABELS: Record<(typeof BOARDS)[number], string> = {
  cbse: 'CBSE',
  state: 'State board',
  icse: 'ICSE',
  other: 'Other',
};

const AFTER_TEN_LABELS: Record<(typeof AFTER_TEN)[number], string> = {
  puc: 'PUC / Class 12',
  diploma: 'Diploma / Polytechnic',
  iti: 'ITI',
  none: 'Nothing yet',
};

const STREAM_LABELS: Record<(typeof STREAMS)[number], string> = {
  pcm: 'Science PCM',
  pcb: 'Science PCB',
  pcmb: 'Science PCMB',
  'pcm-cs': 'Science PCM + CS',
  commerce: 'Commerce',
  arts: 'Arts',
  other: 'Other',
};

const STAGE_LABELS: Record<(typeof STAGES)[number], string> = {
  class_12: 'Still in PUC / Class 12',
  diploma: 'In a diploma',
  iti: 'In an ITI trade',
  undergraduate: 'Reading for a degree',
  postgraduate: 'Reading for a postgraduate degree',
  graduated: 'Finished',
};

const DEGREE_LABELS: Record<(typeof DEGREE_FAMILIES)[number], string> = {
  engineering: 'Engineering',
  medical: 'Medical / health',
  commerce: 'Commerce / business',
  arts: 'Arts / humanities',
  science: 'Science',
  law: 'Law',
  design: 'Design / fine arts',
  other: 'Other',
};

const EXAM_LABELS: Record<EntranceExam, string> = {
  kcet: 'KCET / KEA',
  comedk: 'COMEDK',
  jee: 'JEE',
  neet: 'NEET',
  cuet: 'CUET',
  other: 'Another entrance exam',
};

const CLAIM_LABELS: Record<Claim, string> = {
  '371j': '371(J) — Kalyana Karnataka',
  income: 'Income certificate',
  domicile: 'Domicile / local status',
  pwbd: 'Disability (PwBD)',
  minority: 'Minority',
  sports: 'Sports quota',
  ncc: 'NCC',
  nss: 'NSS',
};

/**
 * A long list — forty branches — as a dropdown rather than forty buttons.
 *
 * Every option is a suggestion: "Not listed" leaves the answer empty, and the
 * field it writes into stays free text, because no list of Indian degree
 * titles is complete.
 */
function Picker({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: readonly string[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="mt-3 block">
      <span className="text-xs font-medium text-slate-700">{legend}</span>
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-xs"
      >
        <option value="">Not listed — I will type it</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function Choice<T extends string>({
  legend,
  options,
  labels,
  value,
  onChange,
}: {
  legend: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="mt-3">
      <legend className="text-xs font-medium text-slate-700">{legend}</legend>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            className={
              value === option
                ? 'rounded border border-slate-800 bg-slate-800 px-2 py-1 text-xs text-white'
                : 'rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50'
            }
          >
            {labels[option]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Multi<T extends string>({
  legend,
  options,
  labels,
  values,
  onChange,
}: {
  legend: string;
  options: readonly T[];
  labels: Record<T, string>;
  values: T[];
  onChange: (values: T[]) => void;
}) {
  return (
    <fieldset className="mt-3">
      <legend className="text-xs font-medium text-slate-700">{legend}</legend>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {options.map((option) => {
          const on = values.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange(on ? values.filter((entry) => entry !== option) : [...values, option])
              }
              className={
                on
                  ? 'rounded border border-slate-800 bg-slate-800 px-2 py-1 text-xs text-white'
                  : 'rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50'
              }
            >
              {labels[option]}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function PathSetup({ path, onSave, onSkip, onCancel }: Props) {
  const [draft, setDraft] = useState<AcademicPath>(path ?? defaultPath());
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<AcademicPath>) => setDraft((was) => ({ ...was, ...patch }));

  const inCollege =
    draft.now === 'undergraduate' || draft.now === 'postgraduate' || draft.now === 'graduated';
  const level = draft.now === 'postgraduate' ? 'pg' : 'ug';
  const courses = coursesFor(draft.degreeFamily, level).map((course) => course.name);
  const branches =
    draft.course === null
      ? [...new Set(coursesFor(draft.degreeFamily, level).flatMap((c) => c.branches ?? []))]
      : [...branchesFor(draft.course)];

  return (
    <section className="rounded border border-slate-300 bg-white p-3">
      <h2 className="text-sm font-semibold text-slate-900">Your education, once</h2>
      <p className="mt-1 text-xs text-slate-600">
        The vault is built from this: the qualifications you actually have, and the documents they
        come with. Only the degree and branch below are saved as details a form can be filled from;
        the rest decides what this panel offers you. You can change any of it whenever you like.
      </p>

      <Choice
        legend="Class 10 board"
        options={BOARDS}
        labels={BOARD_LABELS}
        value={draft.board10}
        onChange={(board10) => set({ board10 })}
      />

      <Choice
        legend="State"
        options={['karnataka', 'other'] as const}
        labels={{ karnataka: 'Karnataka', other: 'Another state' }}
        value={draft.state === 'karnataka' ? 'karnataka' : 'other'}
        onChange={(state) => set({ state: state === 'karnataka' ? 'karnataka' : null })}
      />

      <Choice
        legend="After Class 10"
        options={AFTER_TEN}
        labels={AFTER_TEN_LABELS}
        value={draft.afterTen}
        onChange={(afterTen) => set({ afterTen })}
      />

      {draft.afterTen === 'puc' && (
        <Choice
          legend="Stream"
          options={STREAMS}
          labels={STREAM_LABELS}
          value={draft.stream ?? 'other'}
          onChange={(stream) => set({ stream })}
        />
      )}

      <Choice
        legend="Where you are now"
        options={STAGES}
        labels={STAGE_LABELS}
        value={draft.now}
        onChange={(now) => set({ now })}
      />

      {inCollege && (
        <>
          <Choice
            legend="What you are studying"
            options={DEGREE_FAMILIES}
            labels={DEGREE_LABELS}
            value={draft.degreeFamily ?? 'other'}
            // A different family has different degrees; keeping the old course
            // would leave "MBBS" under "Engineering".
            onChange={(degreeFamily) => set({ degreeFamily, course: null, branch: null })}
          />
          <Picker
            legend="Which degree"
            options={courses}
            value={draft.course}
            onChange={(course) => set({ course, branch: null })}
          />
          {branches.length > 0 && (
            <Picker
              legend="Branch or specialisation"
              options={branches}
              value={draft.branch}
              onChange={(branch) => set({ branch })}
            />
          )}
        </>
      )}

      <Multi
        legend="Entrance exams you have sat"
        options={ENTRANCE_EXAMS}
        labels={EXAM_LABELS}
        values={draft.entrance}
        onChange={(entrance) => set({ entrance })}
      />

      <Choice
        legend="Reservation category"
        options={CATEGORIES}
        labels={{ gm: 'General merit', sc: 'SC', st: 'ST', obc: 'OBC', ews: 'EWS' }}
        value={draft.category}
        onChange={(category) => set({ category })}
      />

      <Multi
        legend="Anything else you claim"
        options={CLAIMS}
        labels={CLAIM_LABELS}
        values={draft.claims}
        onChange={(claims) => set({ claims })}
      />

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void Promise.resolve(onSave(draft)).finally(() => setBusy(false));
          }}
          className="rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:bg-slate-300"
        >
          {busy ? 'Saving…' : 'Build my vault'}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void onSkip()}
            className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            Skip — show me everything
          </button>
        )}
      </div>
    </section>
  );
}
