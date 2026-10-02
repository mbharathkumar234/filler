/**
 * The degrees and branches a student picks from (§ vault structure).
 *
 * A portal asks "Course" and "Branch", and what it wants is the name the
 * university prints — "B.E. / B.Tech", "Computer Science Engineering". Left to
 * free text those become "btech", "B-Tech", "CSE" and "comp sci" across four
 * different applications, and a verification officer reading them side by side
 * has to decide whether they are the same person's answers.
 *
 * So this is a catalogue of suggestions, and **never a restriction**: the
 * fields stay free text, because no list of Indian degree titles is complete —
 * every university adds its own. What the list buys is that the common case is
 * one press and is spelled the same way every time.
 *
 * Pure, and imported only for its suggestions; nothing here narrows what can
 * be stored or what a form can be filled with.
 */

import type { FieldKey } from './taxonomy';
import type { AcademicPath, DegreeFamily } from './pathway';

export type CourseLevel = 'ug' | 'pg';

export interface Course {
  name: string;
  family: DegreeFamily;
  level: CourseLevel;
  /** The specialisations that degree is read in, where it has them. */
  branches?: readonly string[];
}

const ENGINEERING_BRANCHES: readonly string[] = [
  'Computer Science Engineering',
  'Information Technology',
  'Artificial Intelligence',
  'Artificial Intelligence & Machine Learning',
  'Data Science',
  'Cyber Security',
  'Information Science',
  'Software Engineering',
  'Electronics & Communication',
  'Electronics & Instrumentation',
  'VLSI Design',
  'Electrical Engineering',
  'Electrical & Electronics',
  'Mechanical Engineering',
  'Automobile Engineering',
  'Mechatronics',
  'Robotics',
  'Manufacturing Engineering',
  'Industrial Engineering',
  'Civil Engineering',
  'Structural Engineering',
  'Construction Technology',
  'Environmental Engineering',
  'Chemical Engineering',
  'Biomedical Engineering',
  'Biotechnology',
  'Aeronautical Engineering',
  'Aerospace Engineering',
  'Marine Engineering',
  'Petroleum Engineering',
  'Mining Engineering',
  'Metallurgical Engineering',
  'Textile Technology',
  'Food Technology',
  'Instrumentation Technology',
  'Agricultural Engineering',
];

const SCIENCE_BRANCHES: readonly string[] = [
  'Physics',
  'Chemistry',
  'Mathematics',
  'Statistics',
  'Computer Science',
  'Data Science',
  'Biotechnology',
  'Microbiology',
  'Biochemistry',
  'Genetics',
  'Zoology',
  'Botany',
  'Environmental Science',
  'Geology',
  'Agriculture',
  'Horticulture',
  'Forestry',
];

const COMMERCE_BRANCHES: readonly string[] = [
  'Accounting',
  'Finance',
  'Taxation',
  'Banking',
  'Business Analytics',
  'Marketing',
  'Human Resources',
  'International Business',
  'Entrepreneurship',
  'FinTech',
  'Logistics & Supply Chain',
  'Retail Management',
];

const ARTS_BRANCHES: readonly string[] = [
  'English',
  'Kannada',
  'Hindi',
  'Sanskrit',
  'History',
  'Political Science',
  'Economics',
  'Sociology',
  'Psychology',
  'Geography',
  'Philosophy',
  'Journalism',
  'Mass Communication',
  'Public Administration',
  'International Relations',
  'Social Work',
  'Anthropology',
  'Liberal Arts',
];

const ALLIED_HEALTH_BRANCHES: readonly string[] = [
  'Medical Laboratory Technology',
  'Medical Imaging / Radiology',
  'Optometry',
  'Respiratory Therapy',
  'Anaesthesia Technology',
  'Operation Theatre Technology',
  'Cardiac Care Technology',
  'Emergency & Critical Care',
  'Audiology & Speech Language Pathology',
];

const DESIGN_BRANCHES: readonly string[] = [
  'Product Design',
  'Industrial Design',
  'Communication Design',
  'Graphic Design',
  'UX / UI Design',
  'Interaction Design',
  'Transport Design',
  'Textile Design',
  'Fashion Design',
  'Jewellery Design',
  'Interior Design',
  'Game Design',
  'Animation & VFX',
];

/**
 * The catalogue.
 *
 * Undergraduate first, because that is where nearly every user of this is, and
 * a short postgraduate set for the people who carry on. A title that is not in
 * here is typed, and is as valid as any of these.
 */
export const COURSES: readonly Course[] = [
  // Engineering and computing
  { name: 'B.E. / B.Tech', family: 'engineering', level: 'ug', branches: ENGINEERING_BRANCHES },
  { name: 'BCA', family: 'engineering', level: 'ug', branches: ['Computer Applications', 'Data Science', 'Cyber Security'] },
  { name: 'B.Sc Computer Science', family: 'engineering', level: 'ug' },
  { name: 'B.Sc Information Technology', family: 'engineering', level: 'ug' },
  { name: 'Diploma in Engineering', family: 'engineering', level: 'ug', branches: ENGINEERING_BRANCHES },
  { name: 'M.Tech', family: 'engineering', level: 'pg', branches: ENGINEERING_BRANCHES },
  { name: 'MCA', family: 'engineering', level: 'pg' },

  // Medical and health
  { name: 'MBBS', family: 'medical', level: 'ug' },
  { name: 'BDS', family: 'medical', level: 'ug' },
  { name: 'BAMS', family: 'medical', level: 'ug' },
  { name: 'BHMS', family: 'medical', level: 'ug' },
  { name: 'BNYS', family: 'medical', level: 'ug' },
  { name: 'B.Sc Nursing', family: 'medical', level: 'ug' },
  { name: 'B.Pharm', family: 'medical', level: 'ug' },
  { name: 'Pharm.D', family: 'medical', level: 'ug' },
  { name: 'BPT (Physiotherapy)', family: 'medical', level: 'ug' },
  { name: 'B.Sc Allied Health Sciences', family: 'medical', level: 'ug', branches: ALLIED_HEALTH_BRANCHES },
  { name: 'MD / MS', family: 'medical', level: 'pg' },
  { name: 'M.Pharm', family: 'medical', level: 'pg' },

  // Science
  { name: 'B.Sc', family: 'science', level: 'ug', branches: SCIENCE_BRANCHES },
  { name: 'B.Sc (Hons.)', family: 'science', level: 'ug', branches: SCIENCE_BRANCHES },
  { name: 'B.Sc Agriculture', family: 'science', level: 'ug' },
  { name: 'M.Sc', family: 'science', level: 'pg', branches: SCIENCE_BRANCHES },

  // Commerce and business
  { name: 'B.Com', family: 'commerce', level: 'ug', branches: COMMERCE_BRANCHES },
  { name: 'B.Com (Hons.)', family: 'commerce', level: 'ug', branches: COMMERCE_BRANCHES },
  { name: 'BBA', family: 'commerce', level: 'ug', branches: COMMERCE_BRANCHES },
  { name: 'BMS', family: 'commerce', level: 'ug', branches: COMMERCE_BRANCHES },
  { name: 'MBA', family: 'commerce', level: 'pg', branches: COMMERCE_BRANCHES },
  { name: 'M.Com', family: 'commerce', level: 'pg' },

  // Arts and humanities
  { name: 'BA', family: 'arts', level: 'ug', branches: ARTS_BRANCHES },
  { name: 'BA (Hons.)', family: 'arts', level: 'ug', branches: ARTS_BRANCHES },
  { name: 'BSW (Social Work)', family: 'arts', level: 'ug' },
  { name: 'BJMC (Journalism)', family: 'arts', level: 'ug' },
  { name: 'BFA (Fine Arts)', family: 'arts', level: 'ug' },
  { name: 'MA', family: 'arts', level: 'pg', branches: ARTS_BRANCHES },

  // Law
  { name: 'BA LL.B', family: 'law', level: 'ug' },
  { name: 'BBA LL.B', family: 'law', level: 'ug' },
  { name: 'B.Com LL.B', family: 'law', level: 'ug' },
  { name: 'LL.B (3 year)', family: 'law', level: 'ug' },
  { name: 'LL.M', family: 'law', level: 'pg' },

  // Design and the built environment
  { name: 'B.Des', family: 'design', level: 'ug', branches: DESIGN_BRANCHES },
  { name: 'B.Arch', family: 'design', level: 'ug' },
  { name: 'B.Plan', family: 'design', level: 'ug' },
  { name: 'M.Des', family: 'design', level: 'pg', branches: DESIGN_BRANCHES },

  // Everything else people actually read for
  { name: 'BHM (Hotel Management)', family: 'other', level: 'ug' },
  { name: 'B.Voc', family: 'other', level: 'ug' },
  { name: 'B.El.Ed / B.Ed', family: 'other', level: 'ug' },
  { name: 'B.P.Ed (Physical Education)', family: 'other', level: 'ug' },
];

/** The degrees of one family at one level, in catalogue order. */
export function coursesFor(family: DegreeFamily | null, level: CourseLevel): Course[] {
  return COURSES.filter(
    (course) => course.level === level && (family === null || course.family === family),
  );
}

/** The branches of one degree, or nothing for a title the catalogue lacks. */
export function branchesFor(courseName: string): readonly string[] {
  const wanted = courseName.trim().toLowerCase();
  return COURSES.find((course) => course.name.toLowerCase() === wanted)?.branches ?? [];
}

/** Which qualification block a key belongs to, for the two that have courses. */
function levelOf(key: FieldKey): CourseLevel | null {
  if (key.startsWith('education.undergraduate.')) return 'ug';
  if (key.startsWith('education.postgraduate.')) return 'pg';
  return null;
}

/**
 * What to suggest under one box.
 *
 * Only the course and branch boxes of a *degree* block: school has no course,
 * and a suggestion list under "Institution" would be a list of every college
 * in India, which helps nobody.
 */
export function suggestionsFor(key: FieldKey, path: AcademicPath | null): string[] {
  if (path === null) return [];
  const level = levelOf(key);
  if (level === null) return [];

  if (key.endsWith('.course')) {
    return coursesFor(path.degreeFamily, level).map((course) => course.name);
  }

  if (key.endsWith('.branch') || key.endsWith('.specialization')) {
    // The branches of the degree they picked; failing that, everything their
    // family reads for, which is still far shorter than the whole catalogue.
    const picked = path.course === null ? [] : [...branchesFor(path.course)];
    if (picked.length > 0) return picked;

    const all = new Set<string>();
    for (const course of coursesFor(path.degreeFamily, level)) {
      for (const branch of course.branches ?? []) all.add(branch);
    }
    return [...all];
  }

  return [];
}
