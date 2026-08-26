import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PRIVILEGED_TYPES,
  assertSenderMayRequest,
  assertTrustedSender,
  isPrivilegedSender,
  isTrustedSender,
} from './messages';
import { knownTypes } from './validate';

/**
 * The sender gate (§ Phase F page-hostility review).
 *
 * Coverage put `messages.ts` at 12.5% and `background/index.ts` at 11.7%. The
 * gate that decides whether a message is allowed to reach the vault at all had
 * essentially no tests, which is the worst place in this codebase for that to
 * be true — `validate.ts` is depth, and *this* is the primary control.
 *
 * The threat it exists for is stated in `messages.ts` itself: a content script
 * runs inside a hostile portal page, and if one is ever compromised it must not
 * be able to ask the worker for the user's Aadhaar. Chrome sets `sender.tab`
 * for content scripts and leaves it undefined for extension pages, and that one
 * distinction is the whole lock.
 *
 * The last test in this file is the one that matters most: it is not about any
 * particular message, it is about the *list* — a message type added to the
 * union and forgotten here is reachable from a compromised page, silently.
 */

const OUR_ID = 'abcdefghijklmnopabcdefghijklmnop';

beforeEach(() => {
  vi.stubGlobal('chrome', { runtime: { id: OUR_ID } });
});

/** A content script: Chrome always fills in `tab`. */
function contentScript(over: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return {
    id: OUR_ID,
    tab: { id: 7 } as chrome.tabs.Tab,
    frameId: 0,
    url: 'https://portal.example.gov.in/apply',
    ...over,
  };
}

/** The side panel: no `tab`. */
function extensionPage(over: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return {
    id: OUR_ID,
    url: `chrome-extension://${OUR_ID}/src/ui/sidepanel/index.html`,
    ...over,
  };
}

describe('who counts as us', () => {
  it('trusts our own id and nothing else', () => {
    expect(isTrustedSender(extensionPage())).toBe(true);
    expect(isTrustedSender(contentScript())).toBe(true);
  });

  it('refuses another extension, however it dresses the message up', () => {
    const attackers = [
      { id: 'ponmlkjihgfedcbaponmlkjihgfedcba' },
      { id: `${OUR_ID}x` },
      { id: OUR_ID.slice(0, -1) },
      { id: OUR_ID.toUpperCase() },
      { id: '' },
      { id: undefined },
    ];
    for (const attacker of attackers) {
      const sender = { ...extensionPage(), ...attacker } as chrome.runtime.MessageSender;
      expect(isTrustedSender(sender), JSON.stringify(attacker)).toBe(false);
      expect(() => assertTrustedSender(sender)).toThrow(/untrusted sender/);
    }
  });

  it('refuses a sender with no id at all', () => {
    // A message posted from page context arrives without one.
    expect(isTrustedSender({} as chrome.runtime.MessageSender)).toBe(false);
    expect(() => assertTrustedSender({} as chrome.runtime.MessageSender)).toThrow();
  });

  it('names no id it did not receive when it refuses', () => {
    expect(() => assertTrustedSender({} as chrome.runtime.MessageSender)).toThrow(/unknown/);
  });
});

describe('who counts as privileged', () => {
  it('is an extension page, which carries no tab', () => {
    expect(isPrivilegedSender(extensionPage())).toBe(true);
  });

  it('is never a content script, whatever else it claims', () => {
    expect(isPrivilegedSender(contentScript())).toBe(false);
  });

  it('is never a content script pretending to be a panel by its url', () => {
    // The check is `sender.tab === undefined`, and `url` is attacker-influenced
    // in a way `tab` is not — Chrome sets `tab`, the page cannot.
    const liar = contentScript({ url: `chrome-extension://${OUR_ID}/src/ui/sidepanel/index.html` });
    expect(isPrivilegedSender(liar)).toBe(false);
  });

  it('is not fooled by a tab object that looks empty', () => {
    // `sender.tab` present at all means a content script. An empty object is
    // still present, and `=== undefined` is the right test rather than a
    // truthiness check — which this asserts by using a falsy-looking tab.
    for (const tab of [{}, { id: 0 }, { id: -1 }] as chrome.tabs.Tab[]) {
      expect(isPrivilegedSender(contentScript({ tab })), JSON.stringify(tab)).toBe(false);
    }
  });

  it('requires both halves: our id and no tab', () => {
    const foreignPanel = { ...extensionPage(), id: 'ponmlkjihgfedcbaponmlkjihgfedcba' };
    expect(isPrivilegedSender(foreignPanel as chrome.runtime.MessageSender)).toBe(false);
  });
});

describe('what a compromised content script cannot ask for', () => {
  it('is refused every privileged type', () => {
    const refused: string[] = [];
    for (const type of PRIVILEGED_TYPES) {
      try {
        assertSenderMayRequest(type, contentScript());
        refused.push(type); // Reaching here means it was allowed.
      } catch {
        // Correct.
      }
    }
    expect(refused, 'a content script was allowed to request these').toEqual([]);
  });

  it('is told which request was refused, and not why it might work next time', () => {
    expect(() => assertSenderMayRequest('vault:list', contentScript())).toThrow(
      /Rejected privileged request "vault:list" from a content script/,
    );
  });

  it('cannot reach the vault, the documents, or an approval', () => {
    // Named individually because these are the ones whose compromise matters
    // most, and a regression in the set should read as a deleted test.
    for (const type of ['vault:list', 'vault:export', 'vault:set', 'doc:list', 'approval:grant', 'approval:submit']) {
      expect(() => assertSenderMayRequest(type, contentScript()), type).toThrow();
    }
  });

  it('may still send the messages it legitimately owns', () => {
    // The gate must not be "refuse content scripts", or the extension stops
    // working. Harvesting and reporting run there by design.
    for (const type of ['harvest:ready', 'teach:picked', 'fill:refill', 'run:state']) {
      expect(() => assertSenderMayRequest(type, contentScript()), type).not.toThrow();
    }
  });

  it('is refused before the type is even considered when the id is wrong', () => {
    // Ordering matters: `assertTrustedSender` runs first, so an unprivileged
    // type from a foreign extension is still refused.
    const foreign = { ...contentScript(), id: 'ponmlkjihgfedcbaponmlkjihgfedcba' };
    expect(() => assertSenderMayRequest('harvest:ready', foreign as chrome.runtime.MessageSender)).toThrow(
      /untrusted sender/,
    );
  });
});

describe('an extension page may ask for anything', () => {
  it('is allowed every privileged type', () => {
    for (const type of PRIVILEGED_TYPES) {
      expect(() => assertSenderMayRequest(type, extensionPage()), type).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// The list itself
// ---------------------------------------------------------------------------

describe('the privileged list is complete, or the build fails', () => {
  /**
   * The failure this catches has no symptom.
   *
   * Adding `vault:something-new` to the request union and forgetting this list
   * produces working software: the panel calls it, it works, tests pass. The
   * only difference is that a compromised content script can now call it too,
   * and nothing anywhere says so.
   *
   * So the rule is stated as a prefix policy rather than a list to keep in
   * sync by hand. Anything touching the vault, a document, an approval or a
   * stored profile is privileged by default, and an exception has to be
   * written down here on purpose.
   */
  const MUST_BE_PRIVILEGED = [/^vault:/, /^doc:/, /^approval:/, /^llm:set-/];

  /**
   * Types a content script legitimately sends, and why.
   *
   * Every entry is a deliberate decision that a hostile page holding this
   * message type is acceptable. None of them read user data back.
   */
  const DELIBERATELY_OPEN: Record<string, string> = {
    ping: 'liveness only',
    'harvest:request': 'asks the worker to start a harvest; returns no user data',
    'harvest:ready': 'reports that the content script has loaded',
    'fill:apply': 'the worker intersects these against its own plan',
    'fill:refill': 'same, and the refs are checked against the run',
    'fill:submit': 'carries an approval token that is verified separately',
    'fill:undo': 'reverts our own writes',
    'field:focus': 'moves the caret on the page the script already controls',
    'field:apply-edit': 'writes a value the panel supplied',
    'teach:picked': 'reports which element the user clicked; carries no value',
    'teach:pick-start': 'starts the picker',
    'teach:pick-stop': 'stops the picker',
    'run:hello': 'announces a run',
    'run:state': 'reports state the worker already knows',
    'run:continue': 'the user pressed continue',
    'run:abort': 'the user aborted; failing closed is the safe direction',
    'review:collect': 'reads back what is on the page, which the page has',
    'guard:origins': 'lists origins the user granted; no user data',
  };

  it('privileges everything that touches the vault, a document or an approval', () => {
    const unprivileged = [...knownTypes()].filter(
      (type) => MUST_BE_PRIVILEGED.some((rule) => rule.test(type)) && !PRIVILEGED_TYPES.has(type),
    );
    expect(unprivileged.sort(), 'these are reachable from a content script').toEqual([]);
  });

  it('has a written reason for every type it leaves open', () => {
    // Default-deny, applied to the list. A new message type is either
    // privileged or explained; there is no third option that compiles.
    const unexplained = [...knownTypes()].filter(
      (type) => !PRIVILEGED_TYPES.has(type) && !(type in DELIBERATELY_OPEN),
    );
    expect(unexplained.sort(), 'add to PRIVILEGED_TYPES, or justify in DELIBERATELY_OPEN').toEqual([]);
  });

  /**
   * Open types whose names read like a getter, each reviewed once.
   *
   * The point is not that the set is empty — it is that it is *small and
   * enumerated*. A new open type called `profile:get` should stop a build and
   * make somebody write a sentence here, which is the only moment anybody will
   * think about it.
   */
  const ACKNOWLEDGED_READERS: Record<string, string> = {
    'review:collect': 'returns what is currently in the page inputs — the content script can already read those; it learns nothing new',
  };

  it('leaves nothing open whose name suggests it reads user data', () => {
    // Matched on the segment after the colon, whole-word: "harvest:ready" is
    // not a reader, and a substring test says it is.
    const READERISH = new Set(['export', 'list', 'read', 'get', 'status', 'derive', 'collect']);
    const suspicious = Object.keys(DELIBERATELY_OPEN).filter((type) => {
      const verb = type.split(':')[1] ?? type;
      return verb.split('-').some((word) => READERISH.has(word));
    });
    expect(suspicious.sort(), 'an unreviewed open type that sounds like a reader').toEqual(
      Object.keys(ACKNOWLEDGED_READERS).sort(),
    );
  });

  it('has a reason recorded for each acknowledged reader', () => {
    for (const [type, reason] of Object.entries(ACKNOWLEDGED_READERS)) {
      expect(reason.length, type).toBeGreaterThan(30);
      expect(PRIVILEGED_TYPES.has(type), `${type} is privileged; drop it from the list`).toBe(false);
    }
  });

  it('names no privileged type the validator has never heard of', () => {
    // A stale entry is harmless but means the two lists have drifted, and
    // drift is how the previous test stops being true.
    const orphans = [...PRIVILEGED_TYPES].filter((type) => !knownTypes().has(type));
    expect(orphans.sort()).toEqual([]);
  });
});
