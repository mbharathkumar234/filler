/**
 * Choosing the option a saved value means (§ choice questions).
 *
 * A dropdown or a row of radio buttons does not take the value as written: it
 * takes one of its own options. The vault says "Computer Science and
 * Engineering"; the form offers "Computer Science / IT". It says "GM"; the form
 * offers "General / Unreserved". It says 30000; the form offers "Below ₹1,00,000".
 * A person picks without a thought, and so must the filler — in rules that can
 * be read and tested, tried in order of how certain they are:
 *
 *   1. the same words ("KARNATAKA" / "Karnataka", "B.E." / "BE", 01 / 1);
 *   2. the same meaning ("M" / "Male", "Scheduled Tribe" / "ST", "B+" /
 *      "B Positive", "Visvesvaraya Technological University" / "VTU");
 *   3. the band a number falls in (₹30,000 / "Below 1 Lakh", 85% / "Above 75%");
 *   4. the family a course belongs to ("Information Science" / "Computer
 *      Science / IT", "Political Science" / "Arts / Humanities");
 *   5. the words most of an option shares;
 *   6. "Other", with the value given as the answer to type in its box.
 *
 * Steps 4 and 5 — and a band boundary two options share — are inferences, and
 * say so (`sure: false`), so the review screen asks the person to look. When no
 * step decides and there is no "Other", the question is left for the person:
 * a wrong answer chosen confidently is worse than one left blank.
 *
 * Pure: no DOM, no vault, no network. The options are only what the page shows.
 */

import { coverage, normaliseText, similarity, tokenOverlap } from './normalise';

export interface ChoiceOption {
  /** What the person reads beside the option. */
  text: string;
  /** What the page sends for it, when it says: a <select>'s value, a data-value. */
  value?: string;
  /** The page marks this as its "Other", with a box for the answer. */
  other?: boolean;
}

export type ChoiceHow = 'exact' | 'meaning' | 'range' | 'family' | 'words';

export type Choice =
  | { kind: 'option'; index: number; how: ChoiceHow; sure: boolean }
  | { kind: 'other'; index: number; text: string }
  | { kind: 'none'; reason: string };

interface Indexed {
  option: ChoiceOption;
  index: number;
}

interface Hit {
  index: number;
  sure: boolean;
}

export function chooseOption(value: string, options: readonly ChoiceOption[]): Choice {
  const wanted = value.trim();
  if (!wanted) return { kind: 'none', reason: 'There is no saved answer to give.' };

  const offered = options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => !isPlaceholderOption(option));
  const answers = offered.filter(({ option }) => !isOtherOption(option));
  const other = offered.find(({ option }) => isOtherOption(option));

  // "Other" is still an answer when the value says it.
  const exact = sameWords(wanted, offered);
  if (exact) return { kind: 'option', index: exact.index, how: 'exact', sure: exact.sure };

  const steps: Array<[ChoiceHow, (value: string, pool: Indexed[]) => Hit | null]> = [
    ['meaning', sameMeaning],
    ['range', inBand],
    ['family', sameFamily],
    ['words', sharedWords],
  ];
  for (const [how, step] of steps) {
    const hit = step(wanted, answers);
    if (hit) return { kind: 'option', index: hit.index, how, sure: hit.sure };
  }

  if (other) return { kind: 'other', index: other.index, text: wanted };
  const count = answers.length;
  return {
    kind: 'none',
    reason:
      count === 1
        ? 'The one option offered does not fit, and there is no "Other" to write the answer in.'
        : `None of the ${count} options fits, and there is no "Other" to write the answer in.`,
  };
}

// ── The options that are not answers ────────────────────────────────────────

const PLACEHOLDER = /^(please )?(choose|select|pick)( (one|an? \S+|your \S+|the \S+|\S+))?$/;

/** "Choose", "-- Select --", "Select State", or nothing at all. */
export function isPlaceholderOption(option: ChoiceOption): boolean {
  const text = normaliseText(option.text);
  return text === '' || PLACEHOLDER.test(text) || text === 'none selected' || text === 'not selected';
}

const OTHER = /^(any )?others?( (please )?(specify|mention|state|write|describe)( (here|below|it))?)?$/;

/** "Other", "Other:", "Others (please specify)" — or one the page marks. */
export function isOtherOption(option: ChoiceOption): boolean {
  return option.other === true || OTHER.test(normaliseText(option.text));
}

// ── Words ───────────────────────────────────────────────────────────────────

const compact = (text: string) => normaliseText(text).replace(/\s+/g, '');

const plainNumber = (text: string): number | null =>
  /^\d+(\.\d+)?$/.test(text.trim()) ? Number(text.trim()) : null;

/** "General / Unreserved", "Central Board (CBSE)": each name an option goes by. */
function pieces(text: string): string[] {
  const parts = text
    .split(/\s*[/|｜()]\s*|\s+[-–—]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [];
}

/** Words that join others and never decide anything. */
const CHOICE_STOP = new Set(['of', 'and', 'the', 'in', 'for', 'with', 'at', 'to', 'or']);

/**
 * Words every option of a kind shares. "Engineering" names no branch, and
 * "University" no university: an option chosen on one of these alone would be
 * a guess dressed as a match.
 */
const CHOICE_GENERIC = new Set([
  'engineering', 'technology', 'science', 'sciences', 'studies', 'course', 'degree', 'stream',
  'university', 'college', 'board', 'school', 'institute', 'institution', 'education',
  'department', 'government', 'govt', 'state', 'national', 'india', 'indian', 'council',
  'examination', 'examinations', 'secondary', 'higher', 'senior', 'pre', 'bachelor', 'master',
  'bachelors', 'masters', 'honours', 'hons', 'other', 'others', 'general', 'district',
]);

/** "B.Com" → bcom, "B.C.A." → bca: degrees are written with their letters apart. */
const DEGREE_TAILS = new Set(['com', 'sc', 'tech', 'ed', 'arch', 'pharm', 'des', 'voc', 'lib', 'phil', 'plan']);

/** Places renamed in living memory; forms use either name. */
const RENAMES = new Map(
  Object.entries({
    bangalore: 'bengaluru', mysore: 'mysuru', mangalore: 'mangaluru', belgaum: 'belagavi',
    gulbarga: 'kalaburagi', bijapur: 'vijayapura', bellary: 'ballari', shimoga: 'shivamogga',
    tumkur: 'tumakuru', hubli: 'hubballi', chikmagalur: 'chikkamagaluru', davangere: 'davanagere',
    bombay: 'mumbai', madras: 'chennai', calcutta: 'kolkata', gurgaon: 'gurugram',
    pondicherry: 'puducherry', orissa: 'odisha', trivandrum: 'thiruvananthapuram', cochin: 'kochi',
    baroda: 'vadodara', poona: 'pune', allahabad: 'prayagraj',
  }),
);

const isLetter = (token: string) => /^\p{L}$/u.test(token);

export function choiceTokens(text: string): string[] {
  const raw = normaliseText(text).split(' ').filter(Boolean);
  const joined: string[] = [];
  for (let i = 0; i < raw.length; ) {
    if (isLetter(raw[i]!) && i + 1 < raw.length && isLetter(raw[i + 1]!)) {
      let run = '';
      while (i < raw.length && isLetter(raw[i]!)) run += raw[i++];
      joined.push(run);
    } else {
      joined.push(raw[i++]!);
    }
  }
  const merged: string[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const token = joined[i]!;
    const next = joined[i + 1];
    if ((token === 'b' || token === 'm') && next && DEGREE_TAILS.has(next)) {
      merged.push(token + next);
      i += 1;
    } else {
      merged.push(token);
    }
  }
  return merged.map((token) => RENAMES.get(token) ?? token).filter((token) => !CHOICE_STOP.has(token));
}

const choiceKey = (text: string) => choiceTokens(text).join(' ');

/** Step 1: the option says the value — in its words, its sent value, or one of its names. */
function sameWords(value: string, pool: Indexed[]): Hit | null {
  const want = compact(value);
  const number = plainNumber(value);
  if (want) {
    const byText = pool.find(({ option }) => compact(option.text) === want);
    if (byText) return { index: byText.index, sure: true };
    const byValue = pool.find(({ option }) => option.value !== undefined && compact(option.value) === want);
    if (byValue) return { index: byValue.index, sure: true };
  }
  if (number !== null) {
    const byNumber = pool.find(({ option }) => plainNumber(option.text) === number);
    if (byNumber) return { index: byNumber.index, sure: true };
  }
  if (want) {
    const byPiece = pool.filter(
      ({ option }) => !band(option.text) && pieces(option.text).some((piece) => compact(piece) === want),
    );
    if (byPiece.length === 1) return { index: byPiece[0]!.index, sure: true };
  }
  return null;
}

// ── Meaning ─────────────────────────────────────────────────────────────────

/** Each row is one answer, in the spellings forms use for it. */
const CONCEPTS: readonly (readonly string[])[] = [
  ['male', 'm', 'man', 'boy', 'gents', 'पुरुष'],
  ['female', 'f', 'woman', 'girl', 'ladies', 'महिला'],
  ['transgender', 'third gender', 'tg', 'trans'],
  ['yes', 'y', 'true', 'हाँ'],
  ['no', 'n', 'false', 'नहीं'],
  ['single', 'unmarried', 'never married', 'not married'],
  ['married'],
  ['divorced', 'divorcee'],
  ['widowed', 'widow', 'widower'],
  ['general', 'gen', 'gm', 'gn', 'ur', 'unreserved', 'open', 'oc', 'general merit', 'general category', 'open category'],
  ['obc', 'other backward class', 'other backward classes', 'obc ncl', 'obc non creamy layer', 'backward class', 'backward classes', 'bc'],
  ['sc', 'scheduled caste', 'scheduled castes'],
  ['st', 'scheduled tribe', 'scheduled tribes'],
  ['ews', 'economically weaker section', 'economically weaker sections'],
  ['cbse', 'central board of secondary education'],
  ['icse', 'isc', 'cisce', 'indian certificate of secondary education', 'council for the indian school certificate examinations'],
  ['nios', 'national institute of open schooling'],
  ['january', 'jan', '1', '01'],
  ['february', 'feb', '2', '02'],
  ['march', 'mar', '3', '03'],
  ['april', 'apr', '4', '04'],
  ['may', '5', '05'],
  ['june', 'jun', '6', '06'],
  ['july', 'jul', '7', '07'],
  ['august', 'aug', '8', '08'],
  ['september', 'sep', 'sept', '9', '09'],
  ['october', 'oct', '10'],
  ['november', 'nov', '11'],
  ['december', 'dec', '12'],
];

const CONCEPT_INDEX = new Map<string, number[]>();
CONCEPTS.forEach((row, id) => {
  for (const phrase of row) {
    const key = choiceKey(phrase);
    CONCEPT_INDEX.set(key, [...(CONCEPT_INDEX.get(key) ?? []), id]);
  }
});

const STATES = new RegExp(
  `\\b(${[
    'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat',
    'haryana', 'himachal pradesh', 'jharkhand', 'karnataka', 'kerala', 'madhya pradesh',
    'maharashtra', 'manipur', 'meghalaya', 'mizoram', 'nagaland', 'odisha', 'orissa', 'punjab',
    'rajasthan', 'sikkim', 'tamil nadu', 'telangana', 'tripura', 'uttar pradesh', 'uttarakhand',
    'west bengal', 'jammu and kashmir', 'delhi', 'puducherry', 'ladakh', 'chandigarh',
  ].join('|')})\\b`,
);
const STATE_BOARD_NAMES = new Set(['kseeb', 'kseab', 'sslc', 'dpue', 'pue', 'puc']);

/** "State Board" on the form; "Karnataka Secondary Education Examination Board" in the vault. */
function namesStateBoard(text: string): boolean {
  const t = normaliseText(text);
  if (/^state( board| syllabus| government board| govt board| board of education)?$/.test(t)) return true;
  if (/\bstate board\b/.test(t) || STATE_BOARD_NAMES.has(compact(text))) return true;
  return /\b(board|council|pre university)\b/.test(t) && STATES.test(t);
}

/** "B+", "B Positive", "B +ve" → b+ ; nothing for a letter with no sign. */
function bloodGroup(text: string): string | null {
  const t = text.normalize('NFKC').toLowerCase().replace(/[\s()]/g, '').replace(/[−–]/g, '-');
  const m = /^(ab|a|b|o)(?:rh)?(\+|\+ve|positive|pos|-|-ve|negative|neg)$/.exec(t);
  if (!m) return null;
  return m[1] + (m[2]!.startsWith('+') || m[2]!.startsWith('pos') ? '+' : '-');
}

function conceptsOf(text: string): Set<string> {
  const found = new Set<string>();
  const blood = bloodGroup(text);
  if (blood) found.add(`blood ${blood}`);
  for (const piece of [text, ...pieces(text)]) {
    for (const id of CONCEPT_INDEX.get(choiceKey(piece)) ?? []) found.add(`concept ${id}`);
  }
  if (namesStateBoard(text)) found.add('state board');
  return found;
}

const ACRONYM_SKIP = new Set(['of', 'and', 'for', 'the', 'in', 'at', 'on']);

/** "CBSE", "C.B.S.E.", "VTU" → its letters; nothing for an ordinary word. */
function acronym(text: string): string | null {
  return /^(?:\p{Lu}\.?){2,6}$/u.test(text.replace(/\s+/g, '')) ? compact(text) : null;
}

/** "Visvesvaraya Technological University" → vtu. */
function initials(text: string): string | null {
  const words = normaliseText(text)
    .split(' ')
    .filter((word) => word && !ACRONYM_SKIP.has(word));
  if (words.length < 2 || words.some((word) => /^\d/.test(word))) return null;
  return words.map((word) => word[0]).join('');
}

/** Step 2: the option means the value, however differently it is written. */
function sameMeaning(value: string, pool: Indexed[]): Hit | null {
  const key = choiceKey(value);
  const renamed = key ? pool.find(({ option }) => choiceKey(option.text) === key) : undefined;
  if (renamed) return { index: renamed.index, sure: true };

  const meant = conceptsOf(value);
  if (meant.size > 0) {
    const hits = pool.filter(({ option }) => [...conceptsOf(option.text)].some((id) => meant.has(id)));
    if (hits.length === 1) return { index: hits[0]!.index, sure: true };
  }

  const short = acronym(value);
  const long = initials(value);
  const spelled = pool.filter(
    ({ option }) => (short && initials(option.text) === short) || (long && acronym(option.text) === long),
  );
  if (spelled.length === 1) {
    // Two letters stand for too many things to be sure of.
    return { index: spelled[0]!.index, sure: (short ?? long)!.length >= 3 };
  }
  return null;
}

// ── Bands ───────────────────────────────────────────────────────────────────

interface Band {
  lo: number;
  loIn: boolean;
  hi: number;
  hiIn: boolean;
  percent: boolean;
}

const SCALE: Record<string, number> = {
  lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5,
  crore: 1e7, crores: 1e7, cr: 1e7, thousand: 1e3, k: 1e3,
};
const UNIT = '(?:(lakhs?|lacs?|crores?|cr|thousand|k|l)(?![a-z])|(%))';
const AMOUNT = new RegExp(`(\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?)\\s*${UNIT}?`, 'g');
const WHOLE_AMOUNT = new RegExp(`^(\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?)\\s*${UNIT}?$`);

function moneyText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/₹|\brs\b\.?|\binr\b|\/-|\bper annum\b|\bp\.?a\.?$|\bannual(ly)?\b|\bonly\b/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A value that is a number: "30000", "2,75,000", "Rs. 6.5 lakh", "85.17%". */
function amountOf(text: string): { n: number; percent: boolean } | null {
  const m = WHOLE_AMOUNT.exec(moneyText(text));
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, '')) * (m[2] ? SCALE[m[2]]! : 1);
  return Number.isFinite(n) ? { n, percent: Boolean(m[3]) } : null;
}

const HI_BEFORE = /(below|less than|lesser than|under|<)$/;
const HI_IN_BEFORE = /(up ?to|not more than|not exceeding|maximum|max|<=|≤|till)$/;
const LO_BEFORE = /(above|more than|greater than|over|exceeding|>)$/;
const LO_IN_BEFORE = /(minimum|min|at least|>=|≥)$/;
const HI_IN_AFTER = /^(and below|or below|or less|and less|& below)\b/;
const LO_IN_AFTER = /^(and above|or above|or more|and more|& above|onwards|\+)/;

/** "Below 1 Lakh", "₹1,00,001 – ₹2,50,000", "60% - 75%", "5 lakh and above". */
function band(text: string): Band | null {
  const t = moneyText(text);
  const found = [...t.matchAll(AMOUNT)].map((m) => ({
    n: Number(m[1]!.replace(/,/g, '')),
    scale: m[2] ? SCALE[m[2]] : undefined,
    percent: Boolean(m[3]),
    start: m.index!,
    end: m.index! + m[0].length,
  }));
  if (found.length === 0 || found.length > 2) return null;
  const percent = found.some((a) => a.percent);
  // "1 - 2.5 Lakh": a unit written once covers both ends.
  const shared = found.find((a) => a.scale)?.scale;
  const amount = (a: (typeof found)[number]) => a.n * (a.scale ?? (shared && a.n < 1000 ? shared : 1));

  if (found.length === 2) {
    const [a, b] = found as [(typeof found)[number], (typeof found)[number]];
    if (!/^(-|to|and|up ?to)$/.test(t.slice(a.end, b.start).trim())) return null;
    const lo = amount(a);
    const hi = amount(b);
    return lo < hi ? { lo, loIn: true, hi, hiIn: true, percent } : null;
  }
  const [a] = found as [(typeof found)[number]];
  const before = t.slice(0, a.start).trim();
  const after = t.slice(a.end).trim();
  const n = amount(a);
  if (HI_BEFORE.test(before)) return { lo: -Infinity, loIn: false, hi: n, hiIn: false, percent };
  if (HI_IN_BEFORE.test(before) || HI_IN_AFTER.test(after)) return { lo: -Infinity, loIn: false, hi: n, hiIn: true, percent };
  if (LO_BEFORE.test(before)) return { lo: n, loIn: false, hi: Infinity, hiIn: false, percent };
  if (LO_IN_BEFORE.test(before) || LO_IN_AFTER.test(after)) return { lo: n, loIn: true, hi: Infinity, hiIn: false, percent };
  return null;
}

const holds = (b: Band, n: number) =>
  (b.lo < n || (b.loIn && b.lo === n)) && (n < b.hi || (b.hiIn && b.hi === n));

/** Step 3: the value is a number, and the options are the bands it may fall in. */
function inBand(value: string, pool: Indexed[]): Hit | null {
  const amount = amountOf(value);
  if (!amount) return null;
  const bands = pool.map(({ option, index }) => ({ index, band: band(option.text) }));
  const real = bands.filter((entry): entry is { index: number; band: Band } => entry.band !== null);
  if (real.length < 2) return null;
  const percentBands = real.some(({ band: b }) => b.percent);
  // An income is not a percentage, and a percentage is not an income.
  if (percentBands ? !amount.percent && amount.n > 100 : amount.percent) return null;

  const inside = real.filter(({ band: b }) => holds(b, amount.n));
  if (inside.length === 0) return null;
  const onEdge = real.some(({ band: b }) => b.lo === amount.n || b.hi === amount.n);
  return { index: inside[0]!.index, sure: inside.length === 1 && !onEdge };
}

// ── Families of course ──────────────────────────────────────────────────────

/**
 * Courses by the family a form groups them under. A phrase claims its words
 * before a shorter one can: "Computer Science" is computing, never science;
 * "Political Science" is arts. "Engineering" and "Technology" belong to no
 * family — every branch shares them.
 */
const FAMILIES: Record<string, readonly string[]> = {
  computing: [
    'computer science', 'computer engineering', 'computer applications', 'computer application',
    'computers', 'computer', 'computing', 'information technology', 'it', 'information science',
    'information sciences', 'software', 'artificial intelligence', 'machine learning', 'data science',
    'data analytics', 'cyber security', 'cybersecurity', 'internet of things', 'iot', 'cse', 'ise',
    'cs', 'bca', 'mca', 'aiml', 'ai', 'ml', 'ds',
  ],
  electronics: [
    'electronics', 'electronic', 'communication', 'communications', 'telecommunication',
    'telecommunications', 'ece', 'ec', 'instrumentation', 'vlsi', 'embedded systems',
  ],
  electrical: ['electrical', 'eee', 'ee', 'power systems'],
  mechanical: [
    'mechanical', 'automobile', 'automotive', 'production', 'industrial', 'manufacturing',
    'aeronautical', 'aerospace', 'mechatronics', 'marine',
  ],
  civil: ['civil', 'construction', 'structural', 'environmental engineering', 'transportation'],
  chemical: ['chemical', 'chemical engineering', 'petroleum', 'polymer'],
  biotech: ['biotechnology', 'biotech', 'biomedical', 'bioinformatics'],
  architecture: ['architecture', 'barch'],
  science: [
    'science', 'sciences', 'pure science', 'pure sciences', 'natural sciences', 'life sciences',
    'physical sciences', 'physics', 'chemistry', 'mathematics', 'maths', 'math', 'statistics',
    'biology', 'botany', 'zoology', 'microbiology', 'biochemistry', 'genetics', 'geology', 'bsc',
    'msc', 'pcmb', 'pcmc', 'pcm', 'pcb',
  ],
  commerce: [
    'commerce', 'bcom', 'mcom', 'business', 'business administration', 'business management',
    'management', 'bba', 'bbm', 'mba', 'accounting', 'accountancy', 'accounts', 'finance', 'banking',
    'chartered accountancy',
  ],
  arts: [
    'arts', 'humanities', 'ba', 'ma', 'history', 'political science', 'politics', 'sociology',
    'psychology', 'philosophy', 'geography', 'literature', 'english', 'kannada', 'hindi', 'sanskrit',
    'languages', 'journalism', 'mass communication', 'fine arts', 'social work', 'bsw', 'msw',
    'social science', 'social sciences', 'anthropology', 'public administration',
  ],
  law: ['law', 'llb', 'llm', 'legal', 'ballb'],
  medicine: [
    'medicine', 'medical', 'mbbs', 'bds', 'dental', 'nursing', 'pharmacy', 'bpharm', 'mpharm',
    'bams', 'bhms', 'bums', 'physiotherapy', 'bpt', 'paramedical', 'allied health',
  ],
  agriculture: [
    'agriculture', 'agricultural', 'horticulture', 'forestry', 'veterinary', 'fisheries',
    'bsc agriculture',
  ],
};

const FAMILY_PHRASES = Object.entries(FAMILIES)
  .flatMap(([family, phrases]) => phrases.map((phrase) => ({ family, tokens: choiceTokens(phrase) })))
  .sort((a, b) => b.tokens.length - a.tokens.length);

/** Each family a text names, weighted by how many of its words name it. */
function familiesOf(text: string): Map<string, number> {
  const tokens = choiceTokens(text);
  const used = new Array<boolean>(tokens.length).fill(false);
  const weight = new Map<string, number>();
  for (const { family, tokens: phrase } of FAMILY_PHRASES) {
    for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
      if (phrase.every((token, j) => tokens[i + j] === token && !used[i + j])) {
        for (let j = 0; j < phrase.length; j += 1) used[i + j] = true;
        weight.set(family, (weight.get(family) ?? 0) + phrase.length);
      }
    }
  }
  return weight;
}

/** Step 4: the option is the group the value's course belongs to. */
function sameFamily(value: string, pool: Indexed[]): Hit | null {
  const named = familiesOf(value);
  if (named.size === 0) return null;
  const scored = pool
    .map(({ option, index }) => {
      let score = 0;
      for (const family of familiesOf(option.text).keys()) score += named.get(family) ?? 0;
      return { index, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0 || (scored.length > 1 && scored[1]!.score === scored[0]!.score)) return null;
  return { index: scored[0]!.index, sure: false };
}

// ── Shared words ────────────────────────────────────────────────────────────

const FUZZY_FLOOR = 0.8;

/**
 * Step 5: one holds the other ("Bangalore University, Bengaluru" /
 * "Bangalore University") on a word that is not generic — or, failing that,
 * the option is the value with a letter or two wrong.
 */
function sharedWords(value: string, pool: Indexed[]): Hit | null {
  const wanted = choiceTokens(value);
  const scored = pool
    .map(({ option, index }) => {
      const offered = choiceTokens(option.text);
      const distinctive = offered.some((token) => !CHOICE_GENERIC.has(token) && wanted.includes(token));
      const holdsAll = coverage(offered, wanted) === 1 || coverage(wanted, offered) === 1;
      return { index, score: distinctive && holdsAll ? tokenOverlap(wanted, offered) : 0 };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length > 0) {
    if (scored.length > 1 && scored[1]!.score === scored[0]!.score) return null;
    return { index: scored[0]!.index, sure: false };
  }

  const want = compact(value);
  if (want.length < 5) return null;
  const near = pool
    .map(({ option, index }) => ({ index, score: similarity(want, compact(option.text)) }))
    .sort((a, b) => b.score - a.score);
  const [best, next] = near;
  if (!best || best.score < FUZZY_FLOOR || (next && best.score - next.score < 0.1)) return null;
  return { index: best.index, sure: false };
}
