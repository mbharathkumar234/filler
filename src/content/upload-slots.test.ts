// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { harvest } from './harvester';
import {
  cssSelectorFor,
  findUploadButton,
  findUploadSlots,
  isUploadCaption,
  questionLabelFor,
  requirementTextFor,
  questionContainer,
} from './upload-slots';

const everything = () => true;

beforeEach(() => {
  document.body.innerHTML = '';
});

/** A Google Forms file-upload question, reduced to the structure that matters. */
function googleQuestion(title: string, hint: string): string {
  return `
    <div role="listitem">
      <div>
        <div role="heading" aria-level="3">
          <span>${title}</span><span aria-label="Required question"> *</span>
        </div>
        <div>${hint}</div>
      </div>
      <div>
        <div role="button" tabindex="0"><span><svg></svg></span><span>Add file</span></div>
      </div>
      <input type="hidden" name="entry.1" value="">
    </div>`;
}

describe('window slots — an upload button with no file box', () => {
  it('finds a Google Forms upload question, with its caption and its hint', () => {
    document.body.innerHTML = `<div role="list">${googleQuestion(
      'Upload your recent passport size photo',
      'Upload 1 supported file. Max 10 MB.',
    )}</div>`;

    const { slots, elements } = findUploadSlots(document, everything);

    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      ref: 'u0',
      kind: 'window',
      label: 'Upload your recent passport size photo',
      requirementText: 'Upload 1 supported file. Max 10 MB.',
      required: true,
    });
    expect(elements.get('u0')?.getAttribute('role')).toBe('button');
  });

  it('keeps neighbouring questions apart', () => {
    document.body.innerHTML = `<div role="list">
      ${googleQuestion('Upload your Aadhaar card copy', 'Upload 1 supported file: PDF. Max 10 MB.')}
      ${googleQuestion('Upload your 10th marks card', 'Upload 1 supported file. Max 10 MB.')}
    </div>`;

    const { slots } = findUploadSlots(document, everything);

    expect(slots.map((s) => s.label)).toEqual([
      'Upload your Aadhaar card copy',
      'Upload your 10th marks card',
    ]);
    expect(slots[0]?.requirementText).toBe('Upload 1 supported file: PDF. Max 10 MB.');
  });

  it('reads the common upload wordings, and not a table-row "Add"', () => {
    const words = ['Add file', 'Upload', 'Browse…', 'Choose files', 'Attach document', 'Select a photo'];
    document.body.innerHTML = words
      .map((word, i) => `<div><p>Question ${i}</p><div role="button">${word}</div></div>`)
      .join('') +
      '<div><p>Education</p><button type="button">Add qualification</button></div>' +
      '<div><p>Family</p><button type="button">Add</button></div>';

    const { slots } = findUploadSlots(document, everything);

    expect(slots.map((s) => s.label)).toEqual(words.map((_, i) => `Question ${i}`));
  });

  it('reads the caption past an icon font spelling its glyph’s name', () => {
    // Material icons are text: `textContent` reads "file_uploadAdd File".
    document.body.innerHTML = `
      <div role="listitem"><div role="heading">Upload your PAN card copy</div>
        <div role="button"><span class="material-icons">file_upload</span><span>Add File</span></div></div>
      <div role="listitem"><div role="heading">Upload your 10th marks card</div>
        <div role="button"><i>upload</i>Add File</div></div>`;

    const { slots } = findUploadSlots(document, everything);

    expect(slots.map((s) => s.label)).toEqual(['Upload your PAN card copy', 'Upload your 10th marks card']);
  });

  it('finds the question through many layers of wrappers', () => {
    const wrap = (inner: string, depth: number): string =>
      depth === 0 ? inner : `<div><div>${wrap(inner, depth - 1)}</div></div>`;
    document.body.innerHTML = `
      <div role="listitem">
        <div role="heading">Upload your Aadhaar card copy</div>
        <div>Upload 1 supported file. Max 10 MB.</div>
        ${wrap('<div role="button" tabindex="0">Add File</div>', 5)}
      </div>`;

    const { slots } = findUploadSlots(document, everything);

    expect(slots).toMatchObject([{ kind: 'window', label: 'Upload your Aadhaar card copy' }]);
  });

  it('takes the label the button itself points at', () => {
    document.body.innerHTML = `
      <div role="listitem"><span id="t">Upload your recent passport size photo</span>
        <div><div role="button" aria-labelledby="t x">Add File</div></div></div>`;
    expect(findUploadSlots(document, everything).slots[0]?.label).toBe(
      'Upload your recent passport size photo',
    );
  });

  it('leaves a question with its own file box to the harvester', () => {
    document.body.innerHTML = `
      <div><label for="p">Photograph</label>
        <input type="file" id="p"><button type="button">Browse</button></div>`;

    expect(findUploadSlots(document, everything).slots).toEqual([]);
  });

  it('skips controls the user cannot see', () => {
    document.body.innerHTML = googleQuestion('Upload your PAN card copy', 'Max 10 MB.');
    expect(findUploadSlots(document, () => false).slots).toEqual([]);
  });
});

describe('drop slots — a drag-and-drop area with no file box beside it', () => {
  it('finds a Dropzone-style widget whose input lives in <body>', () => {
    document.body.innerHTML = `
      <div class="question">
        <h4>Upload Signature</h4>
        <small>JPEG only, 10 KB to 20 KB</small>
        <div class="dz"><div class="msg"><span>Drop files here to upload</span></div>
          <button type="button">Browse</button></div>
      </div>
      <input type="file" style="display:none">`;

    const { slots, elements } = findUploadSlots(document, everything);

    // One widget, one slot — the drop, because that is the half the
    // extension can complete by itself.
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ kind: 'drop', label: 'Upload Signature' });
    expect(slots[0]?.requirementText).toContain('10 KB to 20 KB');
    expect(elements.get('u0')?.textContent).toBe('Drop files here to upload');
  });

  it('honours an explicit aria-dropeffect', () => {
    document.body.innerHTML = `
      <section><h3>Income certificate</h3><div aria-dropeffect="copy">Put it here</div></section>`;

    const { slots } = findUploadSlots(document, everything);
    expect(slots).toMatchObject([{ kind: 'drop', label: 'Income certificate' }]);
  });
});

describe('a button’s caption is not a question', () => {
  it('knows the generic wording on any upload button', () => {
    for (const caption of ['Choose file', 'Choose Files', 'Browse', 'Browse…', 'Upload', 'Add file', 'Attach']) {
      expect(isUploadCaption(caption), caption).toBe(true);
    }
  });

  it('leaves a portal’s own question alone, even when it starts with "Upload"', () => {
    for (const question of ['Upload Photograph', 'Upload Signature', 'Upload your PAN card copy', 'Photo']) {
      expect(isUploadCaption(question), question).toBe(false);
    }
  });
});

describe('a file box and its question', () => {
  it('names an unlabelled file box after its question', () => {
    document.body.innerHTML = `
      <div class="q"><div role="heading">Upload your 12th marks card</div>
        <div class="widget"><input type="file" hidden></div></div>`;
    expect(questionLabelFor(document.querySelector('input')!)).toBe('Upload your 12th marks card');
  });

  it('reads the hint from aria-describedby first', () => {
    document.body.innerHTML = `
      <p id="h">JPEG, 20 KB to 50 KB</p>
      <div><label for="p">Photo</label><input type="file" id="p" aria-describedby="h"></div>`;
    const input = document.querySelector('input')!;
    const text = requirementTextFor(input, 'Photo', questionContainer(input));
    expect(text.startsWith('JPEG, 20 KB to 50 KB')).toBe(true);
  });

  it('does not borrow the next question’s words', () => {
    document.body.innerHTML = `
      <div>
        <div><span>Photograph</span><input type="file" id="a"></div>
        <div><span>Signature</span><input type="file" id="b"></div>
      </div>`;
    const [a, b] = [...document.querySelectorAll('input')];
    expect(questionLabelFor(a!)).toBe('Photograph');
    expect(questionLabelFor(b!)).toBe('Signature');
  });

  it('gives an unlabelled file box its question’s caption when harvested', () => {
    document.body.innerHTML = `
      <div><h4>Passport size photo</h4><p>JPG, max 50 KB</p>
        <div><input type="file" accept=".jpg,.jpeg"></div></div>`;

    const { fields, labelSources } = harvest(document);

    expect(fields[0]).toMatchObject({
      tag: 'file',
      labelText: 'Passport size photo',
      accept: '.jpg,.jpeg',
      requirementText: 'JPG, max 50 KB',
    });
    expect(labelSources.get(fields[0]!.ref)).toBe('question-heading');
  });

  it('keeps a file box’s own label, and still reads its hint', () => {
    document.body.innerHTML = `
      <table><tr><td>Upload Photograph</td>
        <td><input type="file" name="up_photo" accept="image/jpeg"><small>20 to 50 KB</small></td></tr></table>`;

    const { fields, labelSources } = harvest(document);

    expect(fields[0]?.labelText).toBe('Upload Photograph');
    expect(labelSources.get(fields[0]!.ref)).toBe('table-cell');
    expect(fields[0]?.requirementText).toContain('20 to 50 KB');
  });
});

describe('a file box’s own Upload button', () => {
  it('finds the submit-style Upload beside an ASP.NET file box', () => {
    document.body.innerHTML = `
      <form><table>
        <tr><td>Photograph</td>
          <td><input type="file" id="fuPhoto"><input type="submit" id="btnUploadPhoto" value="Upload"></td></tr>
        <tr><td>Signature</td>
          <td><input type="file" id="fuSign"><input type="submit" id="btnUploadSign" value="Upload"></td></tr>
      </table><input type="submit" id="btnFinal" value="Final Submit"></form>`;

    const final = document.getElementById('btnFinal');
    const photo = findUploadButton(document.getElementById('fuPhoto')!, final);
    const sign = findUploadButton(document.getElementById('fuSign')!, final);

    expect(photo?.button).toEqual({ selector: '#btnUploadPhoto', label: 'Upload' });
    expect(sign?.button.selector).toBe('#btnUploadSign');
  });

  it('never names the form’s final submit, even beside a file box', () => {
    document.body.innerHTML = `
      <form><div><label for="f">Photo</label><input type="file" id="f">
        <input type="submit" id="go" value="Upload"></div></form>`;
    const go = document.getElementById('go');
    expect(findUploadButton(document.getElementById('f')!, go)).toBeNull();
  });

  it('ignores buttons that do something else', () => {
    document.body.innerHTML = `
      <div><label for="f">Photo</label><input type="file" id="f">
        <button type="button">Remove</button><button type="button">View</button></div>`;
    expect(findUploadButton(document.getElementById('f')!, null)).toBeNull();
  });

  it('builds a selector the guard can resolve, even without an id or name', () => {
    document.body.innerHTML = '<div><span><button type="submit">Upload</button></span></div>';
    const button = document.querySelector('button')!;
    const selector = cssSelectorFor(button, document);
    expect(selector.startsWith('//')).toBe(false);
    expect(document.querySelector(selector)).toBe(button);
  });
});

describe('read-only, like the harvester', () => {
  it('leaves the page byte-identical', () => {
    document.body.innerHTML = `<div role="list">${googleQuestion('Upload photo', 'Max 10 MB.')}</div>
      <div><h4>Signature</h4><div aria-dropeffect="copy">Drop files here</div></div>
      <form><div><label for="f">Photo</label><input type="file" id="f">
        <input type="submit" value="Upload"></div></form>`;
    const before = document.body.innerHTML;

    findUploadSlots(document, everything);
    findUploadButton(document.getElementById('f')!, null);
    harvest(document);

    expect(document.body.innerHTML).toBe(before);
  });
});
