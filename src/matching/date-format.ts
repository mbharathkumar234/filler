/**
 * A date written as the box asks for it.
 *
 * The vault keeps every date one way — 2024-03-14 — and an Indian form asks
 * for it in a text box that says how: "DD/MM/YYYY" as its placeholder,
 * "(dd-mm-yyyy)" in its label. Written as kept, the portal refuses it. Pure:
 * the value and what the box shows, in; the value to type, out.
 */

/** "DD/MM/YYYY", "mm-dd-yyyy", "YYYY.MM.DD": three parts, one separator. */
const FORMAT = /\b(dd|mm|yyyy)([/.-])(dd|mm|yyyy)\2(dd|mm|yyyy)\b/i;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The date as `hint` — the box's placeholder and label — says to write it, or
 * as it came when the box says nothing, or when it is not a kept date at all.
 * A native date picker is never given a hint: it takes the date as kept.
 */
export function dateAsAsked(value: string, hint: string): string {
  const date = ISO.exec(value);
  const format = FORMAT.exec(hint);
  if (date === null || format === null) return value;

  const parts: Record<string, string> = { yyyy: date[1]!, mm: date[2]!, dd: date[3]! };
  const order = [format[1]!, format[3]!, format[4]!].map((part) => part.toLowerCase());
  // Each part once: "DD/DD/YYYY" is not a format.
  if (new Set(order).size !== 3) return value;
  return order.map((part) => parts[part]!).join(format[2]!);
}
