// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_DELAY_MS,
  MIN_DELAY_MS,
  findDependentSelects,
  runFill,
  undoFill,
  waitForOptions,
  type PlannedWrite,
} from './fill-run';

function mount(html: string): void {
  document.body.innerHTML = html;
}

/** Resolve by id, mirroring what the real run does with harvested refs. */
const byId = (ref: string): Element | null => document.getElementById(ref);

/** No real waiting in tests; the delays are policy, not behaviour under test. */
const noDelay = () => Promise.resolve();

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('runFill', () => {
  it('fills every field in order and reports each one', async () => {
    mount('<input id="a"><input id="b"><input id="c">');
    const writes: PlannedWrite[] = [
      { ref: 'a', key: 'identity.full_name', value: 'Ravi Kumar' },
      { ref: 'b', key: 'contact.email', value: 'ravi@example.com' },
      { ref: 'c', key: 'address.permanent.pincode', value: '560001' },
    ];

    const { records } = await runFill(writes, { resolve: byId, delay: noDelay });

    expect(records.map((r) => r.ok)).toEqual([true, true, true]);
    expect((document.getElementById('a') as HTMLInputElement).value).toBe('Ravi Kumar');
    expect((document.getElementById('c') as HTMLInputElement).value).toBe('560001');
  });

  it('reports progress after each field', async () => {
    mount('<input id="a"><input id="b">');
    const onProgress = vi.fn();
    await runFill(
      [
        { ref: 'a', key: 'k', value: '1' },
        { ref: 'b', key: 'k', value: '2' },
      ],
      { resolve: byId, delay: noDelay, onProgress },
    );
    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('flags a field that has vanished from the page', async () => {
    mount('<input id="a">');
    const { records } = await runFill([{ ref: 'gone', key: 'k', value: 'x' }], {
      resolve: byId,
      delay: noDelay,
    });
    expect(records[0]).toMatchObject({ ok: false, fillFailed: true, attempts: 0 });
    expect(records[0]?.reason).toMatch(/no longer on the page/);
  });

  it('retries once, then flags — never loops', async () => {
    mount('<input id="a">');
    const input = document.getElementById('a') as HTMLInputElement;
    // A field that refuses every write, as a validator-driven page might.
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => '',
      set: () => {},
    });

    const { records } = await runFill([{ ref: 'a', key: 'k', value: 'x' }], {
      resolve: byId,
      delay: noDelay,
    });

    expect(records[0]).toMatchObject({ ok: false, fillFailed: true, attempts: 2 });
  });

  it('records only one attempt when the first write sticks', async () => {
    mount('<input id="a">');
    const { records } = await runFill([{ ref: 'a', key: 'k', value: 'x' }], {
      resolve: byId,
      delay: noDelay,
    });
    expect(records[0]?.attempts).toBe(1);
  });

  it('carries truncation and fuzzy flags into the record', async () => {
    mount(`
      <input id="a" maxlength="4">
      <select id="s"><option value="">--</option><option value="KA">Karnataka</option></select>
    `);
    const { records } = await runFill(
      [
        { ref: 'a', key: 'identity.full_name', value: 'Ravi Kumar' },
        { ref: 's', key: 'address.permanent.state', value: 'Karnatka' },
      ],
      { resolve: byId, delay: noDelay },
    );

    expect(records[0]?.truncated).toBe(true);
    expect(records[1]?.fuzzy).toBe(true);
  });

  it('stops when the user aborts, leaving the rest untouched', async () => {
    mount('<input id="a"><input id="b"><input id="c">');
    let done = 0;
    const { records, aborted } = await runFill(
      [
        { ref: 'a', key: 'k', value: '1' },
        { ref: 'b', key: 'k', value: '2' },
        { ref: 'c', key: 'k', value: '3' },
      ],
      {
        resolve: byId,
        delay: noDelay,
        onProgress: () => {
          done += 1;
        },
        aborted: () => done >= 2,
      },
    );

    expect(aborted).toBe(true);
    expect(records).toHaveLength(2);
    expect((document.getElementById('c') as HTMLInputElement).value).toBe('');
  });

  it('never clicks or submits anything', async () => {
    mount(`
      <form id="f"><input id="a"><button id="btn" type="submit">Submit</button></form>
    `);
    const submitted = vi.fn();
    const clicked = vi.fn();
    document.getElementById('f')!.addEventListener('submit', submitted);
    document.getElementById('btn')!.addEventListener('click', clicked);

    await runFill([{ ref: 'a', key: 'k', value: 'x' }], { resolve: byId, delay: noDelay });

    expect(submitted).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
  });
});

describe('inter-field delay', () => {
  it('waits between fields, within the documented band', async () => {
    mount('<input id="a"><input id="b"><input id="c">');
    const waits: number[] = [];

    await runFill(
      [
        { ref: 'a', key: 'k', value: '1' },
        { ref: 'b', key: 'k', value: '2' },
        { ref: 'c', key: 'k', value: '3' },
      ],
      {
        resolve: byId,
        delay: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
    );

    // One gap between each adjacent pair, none after the last field.
    expect(waits).toHaveLength(2);
    for (const ms of waits) {
      expect(ms).toBeGreaterThanOrEqual(MIN_DELAY_MS);
      expect(ms).toBeLessThanOrEqual(MAX_DELAY_MS);
    }
  });

  it('does not wait after a single field', async () => {
    mount('<input id="a">');
    const waits: number[] = [];
    await runFill([{ ref: 'a', key: 'k', value: '1' }], {
      resolve: byId,
      delay: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(waits).toEqual([]);
  });
});

describe('dependent dropdowns', () => {
  it('detects a select that has only a placeholder', () => {
    mount(`
      <select id="state"><option value="">--</option><option value="KA">Karnataka</option></select>
      <select id="district"><option value="">-- Select District --</option></select>
    `);
    expect([...findDependentSelects(document)]).toEqual(['district']);
  });

  it('does not treat a populated select as dependent', () => {
    mount(`
      <select id="state"><option value="KA">Karnataka</option></select>
      <select id="gender"><option value="M">Male</option></select>
    `);
    expect(findDependentSelects(document).size).toBe(0);
  });

  it('waits for options to arrive before filling', async () => {
    mount('<select id="district"><option value="">--</option></select>');
    const select = document.getElementById('district') as HTMLSelectElement;

    // The parent select's XHR lands after a couple of polls.
    let polls = 0;
    const delay = () => {
      polls += 1;
      if (polls === 2) {
        const option = document.createElement('option');
        option.value = 'BLR';
        option.textContent = 'Bengaluru';
        select.append(option);
      }
      return Promise.resolve();
    };

    await expect(waitForOptions(select, 3000, delay)).resolves.toBe(true);
  });

  it('gives up rather than hanging when options never arrive', async () => {
    mount('<select id="district"><option value="">--</option></select>');
    const select = document.getElementById('district') as HTMLSelectElement;

    // Timeout of 0 means the deadline has already passed.
    await expect(waitForOptions(select, 0, () => Promise.resolve())).resolves.toBe(false);
  });

  it('does not wait for a non-select field', async () => {
    mount('<input id="a">');
    await expect(waitForOptions(document.getElementById('a')!, 0)).resolves.toBe(true);
  });

  it('fills a dependent select once its options land', async () => {
    mount(`
      <select id="state"><option value="">--</option><option value="KA">Karnataka</option></select>
      <select id="district"><option value="">--</option></select>
    `);

    const district = document.getElementById('district') as HTMLSelectElement;
    let ticks = 0;
    const delay = () => {
      ticks += 1;
      if (ticks === 2) {
        const option = document.createElement('option');
        option.value = 'BLR';
        option.textContent = 'Bengaluru';
        district.append(option);
      }
      return Promise.resolve();
    };

    const { records } = await runFill(
      [
        { ref: 'state', key: 'address.permanent.state', value: 'Karnataka' },
        { ref: 'district', key: 'address.permanent.district', value: 'Bengaluru', dependent: true },
      ],
      { resolve: byId, delay },
    );

    expect(records[1]?.ok).toBe(true);
    expect(district.value).toBe('BLR');
  });

  it('flags a dependent select whose options never load', async () => {
    mount('<select id="district"><option value="">--</option></select>');
    const { records } = await runFill(
      [{ ref: 'district', key: 'address.permanent.district', value: 'X', dependent: true }],
      { resolve: byId, delay: () => Promise.resolve() },
    );
    // The deadline passes once Date.now advances past it; with an instant delay
    // the loop still terminates and reports rather than hanging.
    expect(records[0]?.ok).toBe(false);
    expect(records[0]?.fillFailed).toBe(true);
  }, 10_000);
});

describe('undo', () => {
  it('restores every touched field, including ones the user had filled', async () => {
    mount('<input id="a" value="typed by user"><input id="b">');

    const { snapshots } = await runFill(
      [
        { ref: 'a', key: 'k', value: 'overwritten' },
        { ref: 'b', key: 'k', value: 'new value' },
      ],
      { resolve: byId, delay: noDelay },
    );

    expect((document.getElementById('a') as HTMLInputElement).value).toBe('overwritten');

    const restored = undoFill(snapshots, byId);

    expect(restored).toBe(2);
    expect((document.getElementById('a') as HTMLInputElement).value).toBe('typed by user');
    expect((document.getElementById('b') as HTMLInputElement).value).toBe('');
  });

  it('skips fields that have since vanished', async () => {
    mount('<input id="a" value="x">');
    const { snapshots } = await runFill([{ ref: 'a', key: 'k', value: 'y' }], {
      resolve: byId,
      delay: noDelay,
    });
    document.body.innerHTML = '';
    expect(undoFill(snapshots, byId)).toBe(0);
  });
});
