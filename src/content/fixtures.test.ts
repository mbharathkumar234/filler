// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { harvest } from './harvester';

/**
 * The §Phase 3 Verify step: "run the harvester over every fixture page;
 * snapshot-test the output."
 *
 * Snapshots here are the regression net — any change to label resolution or
 * selector ranking shows up as a reviewable diff rather than as a silently
 * worse harvest. The ">=95% of visible fields labelled" bar is asserted
 * separately, per fixture, because that is the number the plan actually gates on.
 *
 * Fixtures are pulled in with Vite's glob import rather than `node:fs`: this
 * suite runs under jsdom, where `import.meta.url` is an http URL and the Node
 * path helpers do not apply.
 */
const MODULES = import.meta.glob('../../fixtures/*/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const PAGES = Object.entries(MODULES)
  .map(([path, html]) => ({ name: path.split('/').slice(-2).join('/'), html }))
  .filter((page) => !page.name.startsWith('_'))
  .sort((a, b) => a.name.localeCompare(b.name));



beforeEach(() => {
  document.body.innerHTML = '';
});

function harvestHtml(html: string) {
  // Strip the outer document so jsdom's innerHTML parse keeps the body content,
  // but carry the <style> blocks across — visibility depends on them, and a
  // fixture whose `display:none` silently stopped applying would make this
  // suite pass for the wrong reason.
  document.head.innerHTML = '';
  for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const style = document.createElement('style');
    style.textContent = match[1] ?? '';
    document.head.append(style);
  }

  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  document.body.innerHTML = body;
  return harvest(document);
}

describe('fixture corpus', () => {
  it('found fixture pages to test', () => {
    expect(PAGES.length).toBeGreaterThan(0);
  });

  it.each(PAGES)('$name — harvest output snapshot', ({ html }) => {
    const { fields, blockers, wizard } = harvestHtml(html);

    // Selectors are excluded from the snapshot on purpose: structural paths
    // shift with any markup edit, which would make every fixture tweak look
    // like a harvester regression.
    expect({
      fields: fields.map((f) => ({
        ref: f.ref,
        tag: f.tag,
        type: f.type,
        labelText: f.labelText,
        nearbyText: f.nearbyText,
        required: f.required,
        visible: f.visible,
        enabled: f.enabled,
        maxLength: f.maxLength,
        optionCount: f.options?.length,
      })),
      blockers: blockers.map((b) => ({ type: b.type })),
      wizard: wizard ? { step: wizard.step, totalSteps: wizard.totalSteps } : null,
    }).toMatchSnapshot();
  });

  it.each(PAGES)('$name — labels at least 95% of visible fields', ({ html }) => {
    const { fields } = harvestHtml(html);
    const visible = fields.filter((f) => f.visible);
    if (visible.length === 0) return;

    const labelled = visible.filter((f) => f.labelText.trim() !== '');
    const percent = (labelled.length / visible.length) * 100;

    const unlabelled = visible.filter((f) => f.labelText.trim() === '');
    expect(
      percent,
      `unlabelled: ${unlabelled.map((f) => f.selectors[0]).join(', ')}`,
    ).toBeGreaterThanOrEqual(95);
  });

  it.each(PAGES)('$name — every field has at least one selector', ({ html }) => {
    const { fields } = harvestHtml(html);
    for (const field of fields) {
      expect(field.selectors.length, field.labelText).toBeGreaterThan(0);
    }
  });

  it.each(PAGES)('$name — refs are unique', ({ html }) => {
    const { fields } = harvestHtml(html);
    expect(new Set(fields.map((f) => f.ref)).size).toBe(fields.length);
  });
});

describe('the ugly-portal fixture specifically', () => {
  const ugly = PAGES.find((p) => p.name.startsWith('ugly-portal'));

  it('exists', () => {
    expect(ugly).toBeDefined();
  });

  it('does not give the second input in a row the first one’s label', () => {
    const { fields } = harvestHtml(ugly!.html);
    const pin = fields.find((f) => f.selectors.some((s) => s.includes('txtPin')));
    expect(pin?.labelText).not.toBe('City');
    expect(pin?.labelText).toBe('PIN Code');
  });

  it('reads the header row for a grid with no left-hand labels', () => {
    const { fields } = harvestHtml(ugly!.html);
    const labels = fields.map((f) => f.labelText);
    expect(labels).toContain('Board or University');
    expect(labels).toContain('Year of Passing');
  });

  it('distinguishes the two identically-labelled address blocks by section', () => {
    const { fields } = harvestHtml(ugly!.html);
    const line1 = fields.filter((f) => f.labelText === 'Address Line 1');
    expect(line1).toHaveLength(2);
    expect(new Set(line1.map((f) => f.nearbyText)).size).toBe(2);
  });

  it('collapses the radio group into a single field', () => {
    const { fields } = harvestHtml(ugly!.html);
    const gender = fields.filter((f) => f.tag === 'radio-group');
    expect(gender).toHaveLength(1);
    expect(gender[0]?.options).toHaveLength(3);
  });

  it('harvests neither the password nor the hidden ASP.NET machinery', () => {
    const { fields } = harvestHtml(ugly!.html);
    const identifiers = fields.flatMap((f) => f.selectors).join(' ');
    expect(identifiers).not.toMatch(/pwd|password/i);
    expect(identifiers).not.toMatch(/__VIEWSTATE|__EVENTVALIDATION/i);
  });

  it('reports the CAPTCHA field as a blocker rather than a fillable field', () => {
    const { fields, blockers } = harvestHtml(ugly!.html);
    expect(fields.some((f) => f.selectors.some((s) => /captcha/i.test(s)))).toBe(false);
    expect(blockers.some((b) => b.type === 'captcha')).toBe(true);
  });

  it('reports the cross-origin payment frame', () => {
    const { blockers } = harvestHtml(ugly!.html);
    expect(blockers.some((b) => b.reason.includes('payments.example.com'))).toBe(true);
  });

  it('keeps the hidden block as a field, marked not visible', () => {
    const { fields } = harvestHtml(ugly!.html);
    const hidden = fields.find((f) => f.labelText === 'Revealed Later');
    expect(hidden).toBeDefined();
    expect(hidden?.visible).toBe(false);
  });

  it('survives an id rewrite the way a postback would do it', () => {
    const before = harvestHtml(ugly!.html);
    const rewritten = ugly!.html.replace(/ctl00_ContentPlaceHolder1_/g, 'ctl00_ph9_');
    const after = harvestHtml(rewritten);

    expect(after.fields.map((f) => f.labelText)).toEqual(before.fields.map((f) => f.labelText));
  });
});
