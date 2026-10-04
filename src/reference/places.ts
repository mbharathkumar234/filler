/**
 * Indian place names, written one way.
 *
 * RBI's IFSC list and India Post's directory print places in capitals, and
 * each spells a few of them its own way — "ODHISA", "MADHY PRADESH", the two
 * union territories merged in 2020 under their old names. A form's dropdown
 * offers "Odisha" and "Dadra and Nagar Haveli and Daman and Diu". So a state is
 * written as the Constitution now names it, and a district or city in capitals
 * and small letters, its initials as printed. Pure.
 */

const DNH = 'Dadra and Nagar Haveli and Daman and Diu';

/** The 28 states and 8 union territories, as named today. */
export const STATES: readonly string[] = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  DNH,
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
];

/** Old names and the published data's misspellings, by their capitals. */
const ALIASES: Readonly<Record<string, string>> = {
  ODHISA: 'Odisha',
  ORISSA: 'Odisha',
  'MADHY PRADESH': 'Madhya Pradesh',
  'DADAR AND NAGAR HAVELI': DNH,
  'DADRA AND NAGAR HAVELI': DNH,
  'DAMAN AND DIU': DNH,
  PONDICHERRY: 'Puducherry',
  'NCT OF DELHI': 'Delhi',
  'NEW DELHI': 'Delhi',
  'DELHI NCR': 'Delhi',
  UTTARANCHAL: 'Uttarakhand',
  CHATTISGARH: 'Chhattisgarh',
  'TAMILNADU': 'Tamil Nadu',
  'ANDAMAN AND NICOBAR': 'Andaman and Nicobar Islands',
  UTTARKHAND: 'Uttarakhand',
  // A city and a district printed in the state's place in RBI's list.
  LUDHIANA: 'Punjab',
  'DAKSHIN KANNAD': 'Karnataka',
};

/** A name's letters in capitals, "&" read as "and", punctuation as space. */
function capitals(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BY_CAPITALS: ReadonlyMap<string, string> = new Map(STATES.map((state) => [capitals(state), state]));

/** A state as it is named today; a name it does not know, as printed. */
export function canonicalState(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  // "THE DADRA AND NAGAR HAVELI AND DAMAN AND DIU", as India Post prints it.
  const key = capitals(trimmed).replace(/^THE /, '');
  return BY_CAPITALS.get(key) ?? ALIASES[key] ?? trimmed;
}

/** "BENGALURU URBAN" as "Bengaluru Urban"; "Y.S.R." left as printed. */
export function placeName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((word) => {
      if (!/^[A-Za-z]{2,}$/.test(word)) return word;
      const lower = word.toLowerCase();
      if (lower === 'and' || lower === 'of') return lower;
      return lower[0]!.toUpperCase() + lower.slice(1);
    })
    .join(' ');
}
