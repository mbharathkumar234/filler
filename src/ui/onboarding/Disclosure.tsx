/**
 * In-product disclosure (§ Phase 10 Must).
 *
 *   "Clear in-product disclosure: what the extension does, what leaves the
 *    device, what the user is responsible for verifying, and that they remain
 *    responsible for the accuracy of anything submitted."
 *
 * Shown once before the vault is created, and reachable from the panel
 * afterwards. It is deliberately not a wall of legal text with an "I agree" —
 * that trains people to click past exactly the sentences that matter. Four
 * short sections, the last of which is the one nobody can be allowed to miss.
 *
 * The wording here and in `docs/PRIVACY.md` must not drift apart. If the
 * behaviour changes, both change.
 */

const SEEN_KEY = 'disclosure:seen';

export function hasSeenDisclosure(): Promise<boolean> {
  return chrome.storage.local
    .get(SEEN_KEY)
    .then((items) => items[SEEN_KEY] === true)
    .catch(() => false);
}

export function markDisclosureSeen(): Promise<void> {
  return chrome.storage.local.set({ [SEEN_KEY]: true }).catch(() => {});
}

export function Disclosure({ onAccept }: { onAccept?: () => void }) {
  return (
    <section className="p-4 text-slate-900">
      <h2 className="text-base font-semibold">Before you start</h2>

      <div className="mt-3 space-y-3 text-xs leading-relaxed">
        <div>
          <h3 className="text-sm font-medium">What this does</h3>
          <p className="mt-0.5 text-slate-700">
            You save your details once, encrypted on this device. When you press Fill on a form, it
            types them in for you and then <strong>stops</strong>, so you can check every value
            before anything is sent.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-medium">What leaves this device</h3>
          <p className="mt-0.5 text-slate-700">
            Nothing, unless you add your own API key for the optional field-identification helper.
            If you do, it is sent the <em>shape</em> of a form — labels and field names, with
            anything value-like stripped out and checked against your own details first. Your saved
            details, your documents, and the address of the page are never sent.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-medium">What it will not do</h3>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-slate-700">
            <li>Submit a form without your explicit approval.</li>
            <li>Read or solve a CAPTCHA, or read a one-time code.</li>
            <li>Sign anything electronically, or make a payment.</li>
            <li>Fill a password.</li>
          </ul>
          <p className="mt-0.5 text-slate-700">
            When a form reaches one of those, it stops and hands the page back to you.
          </p>
        </div>

        <div className="rounded border border-amber-300 bg-amber-50 p-2">
          <h3 className="text-sm font-medium text-amber-900">What stays your responsibility</h3>
          <p className="mt-0.5 text-amber-900">
            <strong>The accuracy of anything you submit.</strong> This software types faster than
            you do; it does not know whether your details are correct, whether you are eligible, or
            whether a form means what you think it means. Check the review screen before you
            approve — that is what it is for.
          </p>
          <p className="mt-1 text-amber-900">
            There is no password recovery. If you forget your passphrase, your saved details are
            gone. Export a backup and keep it somewhere safe.
          </p>
        </div>
      </div>

      {onAccept && (
        <button
          type="button"
          onClick={() => {
            void markDisclosureSeen().then(onAccept);
          }}
          className="mt-4 w-full rounded bg-slate-900 px-3 py-2 text-sm text-white"
        >
          I understand — set up my vault
        </button>
      )}
    </section>
  );
}
