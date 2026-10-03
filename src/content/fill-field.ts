/**
 * One field, whatever kind it is (§ Phase 5, choice questions).
 *
 * `filler.ts` writes native controls, at once and in one go. Two kinds of
 * question need more than that, and need to wait for the page:
 *
 *  - a Google Forms-style question, answered by pressing an option
 *    (`choice-widgets.ts`);
 *  - a native dropdown or radio group answered "Other", whose box for the
 *    answer is often shown only once "Other" is chosen.
 *
 * The run and the review screen both write through here, so a correction made
 * on the review screen is chosen exactly as the fill chose.
 */

import { choiceWidgetOf, fillChoiceWidget, sleep, until, type Wait } from './choice-widgets';
import { fillElement, fillText, type FileValue, type FillOutcome } from './filler';
import { isVisible } from './harvester';
import { resolveLabel } from './labels';

export async function fillField(el: Element, value: string | FileValue, wait: Wait = sleep): Promise<FillOutcome> {
  if (typeof value === 'string' && choiceWidgetOf(el)) return fillChoiceWidget(el, value, wait);

  const outcome = fillElement(el, value);
  if (!outcome.ok || outcome.otherText === undefined) return outcome;

  const { otherText, ...chosen } = outcome;
  const box = await until(() => specifyBoxAfter(el), wait);
  if (!box) {
    return { ...chosen, fuzzy: true, reason: 'chose "Other", but there is no box beside it for the answer' };
  }
  const typed = fillText(box, otherText);
  return typed.ok ? chosen : { ...chosen, ok: false, reason: 'chose "Other", but its box did not keep the answer' };
}

const TEXT_BOX = /^(text|search|)$/;

/** "If other, please specify", "Others (mention)". */
const SPECIFY = /specify|mention|please state|if (any )?others?\b/i;
/** A box labelled just "Others" — often the radio's own caption, read as the box's. */
const OTHER_ONLY = /^others?\W*$/i;
/** `txtOther`, `gender_other_text` — but not `otherQualification`, another question. */
const OTHER_NAME = /others?([_-]?(text|txt|value|box|specify|details?))?$/i;

/**
 * The box a native "Other" writes its answer in: the next text box after the
 * question, shown, empty, and saying it is for that — and never past the next
 * question's own control. Without those words it is some other question's box,
 * and the answer is better left for the person than typed into it.
 */
function specifyBoxAfter(control: Element): HTMLInputElement | HTMLTextAreaElement | null {
  const doc = control.ownerDocument;
  const name = control.getAttribute('name');
  const group =
    control instanceof HTMLInputElement && control.type === 'radio' && name
      ? [...doc.querySelectorAll('input[type="radio"]')].filter((member) => member.getAttribute('name') === name)
      : [control];
  const last = group[group.length - 1]!;

  let seen = 0;
  for (const next of doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    'input, select, textarea',
  )) {
    if (!(last.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const tag = next.tagName.toLowerCase();
    const type = (next.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'input' && type === 'hidden') continue;
    const isBox = tag === 'textarea' || (tag === 'input' && TEXT_BOX.test(type));
    if (!isBox) return null; // The next question has begun.
    if (!isVisible(next) || next.disabled) continue;
    seen += 1;
    const label = resolveLabel(next).text.trim();
    const words = [label, next.getAttribute('placeholder'), next.getAttribute('aria-label')].join(' ');
    const forOther =
      SPECIFY.test(words) ||
      OTHER_ONLY.test(label) ||
      OTHER_NAME.test(next.getAttribute('name') ?? '') ||
      OTHER_NAME.test(next.getAttribute('id') ?? '');
    if (forOther) return next.value === '' ? (next as HTMLInputElement | HTMLTextAreaElement) : null;
    if (seen >= 2) return null;
  }
  return null;
}
