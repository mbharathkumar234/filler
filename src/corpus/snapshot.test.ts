// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { SNAPSHOT_GENERATOR, snapshotHtml, type SnapshotMeta } from './snapshot';

/**
 * A form captured for the corpus (U0.M1, `MASTER_PROMPT.md`).
 *
 * A snapshot is the form's own HTML with everything that could belong to a
 * person taken out, so the harvester, matcher and filler can be measured on
 * real forms without a single real value reaching the repository. Every
 * "CANARY" below stands for something a page might hold about its user: a
 * typed value, a hidden token, a session in a URL, a photo, a script's data.
 */

const META: SnapshotMeta = {
  category: 'scholarships',
  stack: 'aspnet',
  capturedAt: '2026-10-04',
  origin: 'https://portal.example',
  needsLogin: true,
};

const PAGE = `
<head>
  <meta charset="utf-8">
  <meta name="csrf-token" content="CANARY-CSRF">
  <title>Scholarship application</title>
  <link rel="stylesheet" href="https://cdn.example/site.css?u=CANARY-LINK-CSS">
  <script src="https://cdn.example/app.js?u=CANARY-SCRIPT-SRC"></script>
  <script>window.user = "CANARY-SCRIPT";</script>
  <style>.photo { background: url("https://cdn.example/bg.png?u=CANARY-STYLE") } label { font-weight: bold }
  @import url("https://cdn.example/more.css?u=CANARY-IMPORT"); .gone { display: none }</style>
  <base href="https://portal.example/CANARY-BASE/">
</head>
<body onload="track('CANARY-HANDLER')">
  <!-- logged in as CANARY-COMMENT -->
  <img src="https://portal.example/photo?id=CANARY-PHOTO" srcset="https://portal.example/p2?id=CANARY-SRCSET 2x" alt="Applicant photo">
  <a href="https://portal.example/profile?id=CANARY-HREF#CANARY-HASH">My profile</a>
  <h2>Personal details</h2>
  <form action="https://portal.example/submit?session=CANARY-ACTION" method="post">
    <input type="hidden" name="__VIEWSTATE" value="CANARY-VIEWSTATE">
    <label for="n">Name of the applicant</label>
    <input id="n" name="name" type="text" value="CANARY-NAME" maxlength="60" pattern="[A-Za-z ]+" autocomplete="name" data-user="CANARY-DATA" aria-describedby="n-hint">
    <span id="n-hint">As in your SSLC marks card</span>
    <label for="e">Email</label><input id="e" type="email" value="CANARY-EMAIL" placeholder="you@example.com">
    <label for="a">Address</label><textarea id="a" name="address">CANARY-ADDRESS</textarea>
    <label for="g">Gender</label>
    <select id="g" name="gender"><option value="">--Select--</option><option value="M" selected>Male</option><option value="F">Female</option></select>
    <input type="radio" id="c1" name="cat" value="GM" checked><label for="c1">General</label>
    <input type="radio" id="c2" name="cat" value="SC"><label for="c2">SC</label>
    <input type="checkbox" id="ok" name="agree" checked><label for="ok">I agree</label>
    <div contenteditable="true">CANARY-RICH</div>
    <input type="password" name="pw" value="CANARY-PASSWORD">
    <input type="range" name="r" aria-valuetext="CANARY-ARIA" value="5">
    <div class="gone"><label for="s">Spouse's name</label><input id="s" name="spouse"></div>
    <div class="photo" style="background-image: url('https://portal.example/me.jpg?u=CANARY-INLINE')"></div>
    <iframe src="https://pay.example/?u=CANARY-FRAME"></iframe>
    <name-field id="host"></name-field>
    <button type="submit" formaction="https://portal.example/go?u=CANARY-FORMACTION" onclick="go('CANARY-CLICK')">Submit</button>
  </form>
</body>`;

function capture(): string {
  return snapshotHtml(document, META);
}

beforeEach(() => {
  document.documentElement.innerHTML = PAGE;
  // What the person typed lives in the properties, not the markup.
  (document.getElementById('n') as HTMLInputElement).value = 'CANARY-LIVE-TYPED';
  (document.getElementById('a') as HTMLTextAreaElement).value = 'CANARY-LIVE-ADDRESS';
  // A field inside an open shadow root, as a component library builds it.
  const host = document.getElementById('host')!;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<label for="f">Father\'s name</label><input id="f" name="father" value="CANARY-SHADOW">';
});

describe('a snapshot keeps nothing about the person', () => {
  it('holds no value, token, script, handler, comment, photo or URL from the page', () => {
    const html = capture();
    expect(html).not.toMatch(/CANARY/);
  });

  it('runs nothing and loads nothing when opened', () => {
    const html = capture();
    expect(html).not.toMatch(/<script|<iframe|<link|<base|<object|<embed/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\b(?:selected|checked)\b/);
  });

  it('leaves the page it was taken from exactly as it was', () => {
    const before = document.documentElement.outerHTML;
    capture();
    expect(document.documentElement.outerHTML).toBe(before);
    expect((document.getElementById('n') as HTMLInputElement).value).toBe('CANARY-LIVE-TYPED');
  });
});

describe('a snapshot keeps the form', () => {
  it('keeps every label, hint, heading and attribute the matcher reads', () => {
    const html = capture();
    for (const kept of [
      'Name of the applicant',
      'As in your SSLC marks card',
      'Personal details',
      'id="n"',
      'name="name"',
      'maxlength="60"',
      'pattern="[A-Za-z ]+"',
      'autocomplete="name"',
      'aria-describedby="n-hint"',
      'placeholder="you@example.com"',
      'name="__VIEWSTATE"',
      'type="password"',
    ]) {
      expect(html, kept).toContain(kept);
    }
  });

  it('keeps the choices a form offers, chosen or not', () => {
    const html = capture();
    expect(html).toContain('<option value="M">Male</option>');
    expect(html).toContain('<option value="">--Select--</option>');
    expect(html).toContain('value="GM"');
    expect(html).toContain('value="SC"');
    expect(html).toContain('<button type="submit">Submit</button>');
  });

  it('keeps a field built inside a component, as the browser can open it again', () => {
    const html = capture();
    expect(html).toMatch(/<name-field id="host"><template shadowrootmode="open"><label for="f">Father's name<\/label><input id="f" name="father"><\/template><\/name-field>/);
  });

  it('marks what the page’s own styles hid, since those styles are not kept', () => {
    const html = capture();
    expect(html).toMatch(/<div class="gone" hidden="">/);
  });

  it('keeps the page’s own styles, less anything they would fetch', () => {
    const html = capture();
    expect(html).toContain('label { font-weight: bold }');
    expect(html).not.toMatch(/@import/);
  });

  it('says what it is, where it came from and when', () => {
    const html = capture();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`<meta name="generator" content="${SNAPSHOT_GENERATOR}">`);
    expect(html).toContain('<meta name="corpus:category" content="scholarships">');
    expect(html).toContain('<meta name="corpus:stack" content="aspnet">');
    expect(html).toContain('<meta name="corpus:captured" content="2026-10-04">');
    expect(html).toContain('<meta name="corpus:origin" content="portal.example">');
    expect(html).toContain('<meta name="corpus:login" content="yes">');
    expect(html).toContain('<title>Scholarship application</title>');
  });

  it('keeps the codes a Google Forms-style question gives its options, and not what was chosen', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div role="radiogroup" aria-label="Category">
         <div role="radio" data-value="GM" aria-checked="true">General</div>
         <div role="radio" data-value="OBC" aria-checked="false">OBC</div>
       </div>
       <div role="listbox" aria-label="District"><div role="option" data-value="BLR" aria-selected="true">Bengaluru</div></div>
       <div class="answer" data-value="CANARY-ANSWER">x</div>`,
    );
    const html = capture();
    expect(html).toContain('<div role="radio" data-value="GM">General</div>');
    expect(html).toContain('<div role="option" data-value="BLR">Bengaluru</div>');
    expect(html).not.toMatch(/CANARY|aria-checked|aria-selected/);
  });

  it('marks where a frame stood, without what was in it', () => {
    const html = capture();
    expect(html).toContain('<div data-snapshot-frame=""></div>');
  });
});
