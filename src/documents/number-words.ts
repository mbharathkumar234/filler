/**
 * An amount written out in words (§ reading a document).
 *
 * A certificate that states money states it twice — "30000 ( Rs. thirty
 * thousand only.)" — and the two are recognised independently. On the user's
 * own income certificate the recogniser dropped the bold digits and kept the
 * words, so the words are a second way to the same number.
 *
 * Indian counting: thousand, lakh, crore. A word the recogniser clipped is
 * accepted only when exactly one number word fits it; "thirt" could be thirty
 * or thirteen, and a guess there is a wrong income on an application.
 */

const UNITS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const MULTIPLIERS: Readonly<Record<string, number>> = {
  hundred: 100,
  thousand: 1000,
  lakh: 100000,
  lakhs: 100000,
  lac: 100000,
  lacs: 100000,
  crore: 10000000,
  crores: 10000000,
};

/** Words that sit around an amount and are not part of it. */
const FILLER = new Set(['and', 'only', 'rupees', 'rupee', 'rs', 'inr']);

const WORDS = [...Object.keys(UNITS), ...Object.keys(MULTIPLIERS)];

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/**
 * The number word a token is, allowing for a clipped ending.
 *
 * Exact first. Otherwise the word sharing the longest beginning with the token
 * — at least four letters, and longer than any rival's. A tie is no answer.
 */
function wordFor(token: string): string | null {
  if (token in UNITS || token in MULTIPLIERS) return token;

  let best: string | null = null;
  let bestLength = 0;
  let tied = false;
  for (const word of WORDS) {
    const shared = commonPrefix(token, word);
    if (shared < 4 || Math.abs(word.length - token.length) > 3) continue;
    if (shared > bestLength) {
      best = word;
      bestLength = shared;
      tied = false;
    } else if (shared === bestLength && best !== null && valueOf(word) !== valueOf(best)) {
      tied = true;
    }
  }
  return tied ? null : best;
}

const valueOf = (word: string): number => UNITS[word] ?? MULTIPLIERS[word] ?? 0;

/** The amount a run of words states, or null when they state none. */
export function amountInWords(text: string): number | null {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((token) => token !== '' && !FILLER.has(token));

  let total = 0;
  let current = 0;
  let read = 0;

  for (const token of tokens) {
    const word = wordFor(token);
    // The amount ends at the first word that is not part of one; a word that
    // cannot be placed before anything was read means there is no amount here.
    if (word === null) {
      if (read === 0) return null;
      break;
    }
    read += 1;

    if (word in UNITS) {
      current += UNITS[word]!;
    } else if (word === 'hundred') {
      current = Math.max(1, current) * 100;
    } else {
      total += Math.max(1, current) * MULTIPLIERS[word]!;
      current = 0;
    }
  }

  const amount = total + current;
  return read === 0 || amount === 0 ? null : amount;
}
