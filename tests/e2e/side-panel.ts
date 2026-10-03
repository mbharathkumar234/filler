import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from '@playwright/test';

/**
 * The extension's real side panel, driven from a test.
 *
 * The worker answers vault and document requests only from an extension page
 * that is not in a tab — a tab is what a content script looks like, and that
 * refusal is the guard (`isPrivilegedSender`). So the panel cannot be tested by
 * opening its HTML in a tab: it has to be the side panel itself. Playwright does
 * not attach to a side panel, so this opens one with a real click (the API
 * insists on a user gesture) and drives it over the DevTools protocol.
 *
 * Driving the real thing is the point. Pressing it by hand found four bugs no
 * other test could see — a value box ninety pixels wide, a reading that read
 * the copy being replaced, a warning said twice, a label hidden by a speck —
 * because unit tests have no layout, and the other browser tests have no vault.
 *
 * The same connection watches every extension page and worker for requests
 * that leave the extension, so "nothing left the device" covers the panel, the
 * service worker, the offscreen page and the reader's own worker — and says
 * which of them it saw, so a watch that missed one cannot pass quietly.
 */

/** Helpers installed in the panel, for the functions a test runs there. */
export interface PanelHelpers {
  text(element: Element | null | undefined): string;
  /** A button by its label or its words, within `root`. */
  button(name: string, root?: ParentNode | null): HTMLButtonElement | null;
  /** The row of a document slot, by the slot's label. */
  slot(label: string): HTMLLIElement | null;
  /** The details read from a slot's document, while they are on screen. */
  reading(label: string): HTMLElement | null;
  /** Type into a box the way a person does, so React hears it. */
  type(box: HTMLInputElement | HTMLTextAreaElement, value: string): void;
}

declare global {
  var __panel: PanelHelpers;
}

function installHelpers() {
  const text = (element: Element | null | undefined) =>
    (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  globalThis.__panel = {
    text,
    button(name, root = document) {
      return (
        [...(root ?? document).querySelectorAll('button')].find(
          (b) => b.getAttribute('aria-label') === name || text(b) === name,
        ) ?? null
      );
    },
    slot(label) {
      return (
        [...document.querySelectorAll('li')].find(
          (li) =>
            li.querySelector('input[type="file"]') !== null &&
            [...li.querySelectorAll('span')].some((span) => text(span) === label),
        ) ?? null
      );
    },
    reading(label) {
      return globalThis.__panel.slot(label)?.querySelector<HTMLElement>('section[aria-labelledby="extract-heading"]') ?? null;
    },
    type(box, value) {
      const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(box, value);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    },
  };
}

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };

/** One DevTools connection to the whole browser, with a session per target. */
class Cdp {
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: Message) => void>();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Message;
      const waiting = message.id === undefined ? undefined : this.waiting.get(message.id);
      if (waiting !== undefined) {
        this.waiting.delete(message.id!);
        if (message.error) waiting.reject(new Error(message.error.message));
        else waiting.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  on(listener: (message: Message) => void) {
    this.listeners.add(listener);
  }

  close() {
    this.socket.close();
  }
}

export interface SidePanel {
  /** The extension's id: its pages are `chrome-extension://<id>/…`. */
  id: string;
  context: BrowserContext;
  /**
   * Run `fn` in the panel. It is sent as source, so it may use only its
   * arguments and `__panel`; arguments and result travel as JSON.
   */
  run<A extends unknown[], T>(fn: (...args: A) => T | Promise<T>, ...args: A): Promise<Awaited<T>>;
  /** Wait until `fn`, run in the panel, returns something truthy, and return it. */
  until<A extends unknown[], T>(what: string, fn: (...args: A) => T, args: A, timeout?: number): Promise<T>;
  /** Choose files on disk in the file box `fn` finds, as a person would. */
  choose<A extends unknown[]>(fn: (...args: A) => Element | null, args: A, files: string[]): Promise<void>;
  /**
   * Press the extension's toolbar button on the tab showing `url`.
   *
   * That click is what grants `activeTab` — the one tab the extension may then
   * read and fill — and no page can make it. The DevTools protocol can, which
   * is what lets a test run a real fill: until this, the injection into a
   * granted page was the one step no test could reach.
   */
  pressToolbarButton(url: string): Promise<void>;
  /** Send a request to the worker from the panel, as the panel does. */
  ask<T>(payload: Record<string, unknown>): Promise<{ ok: boolean; data?: T; error?: string }>;
  /** Requests any extension page or worker made outside the extension. */
  outside: string[];
  /** Every request seen, and the kind of target that made it. */
  traffic: Array<{ type: string; url: string }>;
  /** Exceptions, console errors and warnings in the panel. */
  problems: string[];
  /**
   * Exceptions, console errors and warnings in **every** extension page and
   * worker — the offscreen page, the reader inside it and its threads, the
   * service worker, the panel — each with the kind of target it came from.
   * What `chrome://extensions` lists under the extension's Errors.
   */
  logged: string[];
  /** The kinds of extension targets whose requests were watched. */
  watched: Set<string>;
  close(): Promise<void>;
}

async function devtoolsPort(profile: string): Promise<number> {
  const file = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The browser never said which port DevTools is on.');
}

export async function openSidePanel(dist: string): Promise<SidePanel> {
  const profile = mkdtempSync(join(tmpdir(), 'autofill-panel-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1100, height: 950 },
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--no-first-run',
      // Any free port; the browser writes which into the profile.
      '--remote-debugging-port=0',
      // What lets the DevTools protocol press the toolbar button.
      '--enable-unsafe-extension-debugging',
    ],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const ours = (url: string) => url.startsWith(`chrome-extension://${id}/`);

    const port = await devtoolsPort(profile);
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const cdp = new Cdp(socket);

    // --- every extension page and worker, watched for requests that leave ---
    const outside: string[] = [];
    const traffic: Array<{ type: string; url: string }> = [];
    const watched = new Set<string>();
    const sessions = new Map<string, string>();
    const attached = new Set<string>();
    const logged: string[] = [];
    // Terminal colours, which a native library's log carries into the console:
    // ESC, then "[0;93m" and the like.
    const ESC = String.fromCharCode(27);
    const plain = (text: string) =>
      text
        .split(ESC)
        .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;]*m/, '')))
        .join('');

    /** Watch one target's requests, and hold any worker it starts until that is watched too. */
    const watch = async (sessionId: string, type: string, waiting: boolean) => {
      if (sessions.has(sessionId)) return;
      sessions.set(sessionId, type);
      watched.add(type);
      await cdp.send('Network.enable', {}, sessionId).catch(() => {});
      // Its console too, before it runs a line, so nothing it says goes unheard.
      await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
      // Its own workers — the reader's, inside the offscreen page — paused at
      // their first line until their network is watched, so not one request
      // goes by unseen.
      await cdp
        .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
        .catch(() => {});
      if (waiting) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    };
    const attach = (info: { targetId: string; url: string }) => {
      // A new page has no address at first; it is attached once it has ours.
      if (!ours(info.url) || attached.has(info.targetId)) return;
      attached.add(info.targetId);
      void cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true }).catch(() => {
        attached.delete(info.targetId);
      });
    };

    cdp.on((message) => {
      if (message.method === 'Network.requestWillBeSent') {
        const url = String((message.params?.request as { url?: string } | undefined)?.url ?? '');
        traffic.push({ type: sessions.get(String(message.sessionId)) ?? 'unknown', url });
        if (!ours(url) && !url.startsWith('data:') && !url.startsWith('blob:')) outside.push(url);
      }
      const from = sessions.get(String(message.sessionId));
      if (from !== undefined && message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.exceptionDetails as { text?: string; exception?: { description?: string } };
        logged.push(`${from} exception: ${plain(details.exception?.description ?? details.text ?? '')}`);
      }
      if (from !== undefined && message.method === 'Runtime.consoleAPICalled') {
        const type = String(message.params?.type);
        if (type === 'error' || type === 'warning' || type === 'assert') {
          const args = (message.params?.args as Array<{ value?: unknown; description?: string }>) ?? [];
          logged.push(`${from} ${type}: ${plain(args.map((a) => String(a.value ?? a.description)).join(' '))}`);
        }
      }
      if (message.method === 'Target.attachedToTarget') {
        const info = message.params?.targetInfo as { targetId: string; type: string; url: string };
        const sessionId = String(message.params?.sessionId);
        const waiting = message.params?.waitingForDebugger === true;
        // Ours because this watch asked for it — a page being loaded reports
        // no address for a moment, and the offscreen page was missed that way
        // — or because a watched target started it, paused, as with a worker.
        if (attached.has(info.targetId) || waiting || ours(info.url)) void watch(sessionId, info.type, waiting);
      }
      if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') {
        attach(message.params?.targetInfo as { targetId: string; url: string });
      }
    });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>(
      'Target.getTargets',
    );
    for (const info of targetInfos) attach(info);

    // --- the panel, opened with a real click ---------------------------------
    const tab = await context.newPage();
    await tab.goto(`chrome-extension://${id}/practice/first-fill.html`);
    await tab.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'open-the-side-panel';
      button.textContent = 'Open the side panel';
      button.onclick = async () => {
        const window = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: window.id! });
        document.title = 'panel open';
      };
      document.body.prepend(button);
    });
    await tab.click('#open-the-side-panel');
    await tab.waitForFunction(() => document.title === 'panel open');

    let panelSession: string | null = null;
    for (let i = 0; i < 80 && panelSession === null; i += 1) {
      const { targetInfos: now } = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; attached: boolean }> }>(
        'Target.getTargets',
      );
      const target = now.find((info) => info.url.includes('/src/ui/sidepanel/index.html'));
      if (target !== undefined) {
        const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        });
        panelSession = sessionId;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (panelSession === null) throw new Error('The side panel never opened.');
    const session = panelSession;
    await watch(session, 'side panel', false);

    const problems: string[] = [];
    cdp.on((message) => {
      if (message.sessionId !== session) return;
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.exceptionDetails as { text?: string; exception?: { description?: string } };
        problems.push(`exception: ${details.exception?.description ?? details.text}`);
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const type = String(message.params?.type);
        if (type === 'error' || type === 'warning') {
          const args = (message.params?.args as Array<{ value?: unknown; description?: string }>) ?? [];
          problems.push(`${type}: ${args.map((a) => String(a.value ?? a.description)).join(' ')}`);
        }
      }
    });
    await cdp.send('Runtime.enable', {}, session);
    await cdp.send('DOM.enable', {}, session);

    const evaluate = async (expression: string, byValue = true) => {
      const reply = await cdp.send<{ result: { value?: unknown; objectId?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: byValue, userGesture: true },
        session,
      );
      if (reply.exceptionDetails) {
        throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      }
      return reply.result;
    };
    await evaluate(`(${installHelpers.toString()})()`);
    const call = (fn: (...args: never[]) => unknown, args: unknown[]) =>
      `(async () => (${fn.toString()})(...${JSON.stringify(args)}))()`;

    const panel: SidePanel = {
      id,
      context,
      outside,
      traffic,
      problems,
      logged,
      watched,
      async run(fn, ...args) {
        return (await evaluate(call(fn as never, args))).value as never;
      },
      async until(what, fn, args, timeout = 30_000) {
        const end = Date.now() + timeout;
        for (;;) {
          const value = (await evaluate(call(fn as never, args))).value;
          if (value) return value as never;
          if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      },
      async choose(fn, args, files) {
        const { objectId } = await evaluate(call(fn as never, args), false);
        if (objectId === undefined) throw new Error('There is no file box there.');
        await cdp.send('DOM.setFileInputFiles', { objectId, files }, session);
      },
      async pressToolbarButton(url) {
        const { targetInfos: all } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>(
          'Target.getTargets',
          // Tab targets are left out of the list unless asked for.
          { filter: [{}] },
        );
        const tab = all.find((info) => info.type === 'tab' && info.url === url);
        if (tab === undefined) throw new Error(`No tab is showing ${url}.`);
        await cdp.send('Extensions.triggerAction', { id, targetId: tab.targetId });
      },
      async ask(payload) {
        return (await evaluate(
          `chrome.runtime.sendMessage(${JSON.stringify({ __af: true, at: Date.now(), payload })})`,
        )).value as never;
      },
      async close() {
        cdp.close();
        await context.close();
        rmSync(profile, { recursive: true, force: true });
      },
    };
    return panel;
  } catch (error) {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}
