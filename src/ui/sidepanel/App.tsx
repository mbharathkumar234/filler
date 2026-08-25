/**
 * Phase 0 side panel. The only thing it must do is load and say "Hello" —
 * that is the Phase 0 gate. The harvested-field list arrives in Phase 3, the
 * review screen in Phase 7.
 */
export function App() {
  return (
    <main className="min-h-screen bg-white p-4 font-sans text-slate-900">
      <h1 className="text-lg font-semibold">Hello</h1>
      <p className="mt-2 text-sm text-slate-600">
        AutoFill Assistant is installed. Nothing is harvested, matched, or filled yet —
        that starts in Phase 3.
      </p>
      <ul className="mt-4 space-y-1 text-xs text-slate-500">
        <li>This extension never submits a form without your explicit approval.</li>
        <li>Your data stays on this device.</li>
      </ul>
    </main>
  );
}
