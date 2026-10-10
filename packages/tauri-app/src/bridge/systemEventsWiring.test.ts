import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ActiveTimer, AppData, RendererApi } from '@tiny-schedule/shared';
import { emptyAppData } from '@tiny-schedule/shared';
import { installApi } from '@/api';
import { HOST_EVENTS } from '@/api/timer';
import { useDataStore } from '@/stores/data';
import { useTimerStore } from '@/stores/timer';
import { installTauriMocks } from '@/test/tauriMocks';
import { DataStore } from './dataStore';
import { joinPath, MemoryFs } from './fsAdapter';
import { SLEEP_POLL_MS } from './systemEventsLogic';

/**
 * Wiring tests for `systemEvents.ts` — the file that decides whether a running
 * timer gets paused behind the user's back, and whether the quit settlement is
 * one atomic write or two.
 *
 * These live apart from `systemEventsLogic.test.ts`, which tests the judgements
 * with no Tauri, no store and no clock. What is worth pinning here is exactly
 * what those judgements cannot see: that the sleep watcher *hands the gap* to
 * the pause, that the idle reading is measured rather than guessed, and that
 * the quit path moves the task and the timer together in one write.
 *
 * The host events are captured rather than stubbed to no-ops: `startSystemEvents`
 * subscribes through `listen`, and the bridge only ever does anything in
 * response to one of those callbacks, so a test that cannot fire them could
 * only assert that nothing happened.
 */
installTauriMocks();

/** One callback per host channel, in subscription order. */
const hostHandlers = new Map<string, (event: { payload: unknown }) => void>();
/** What the quit confirmation answered, per test. */
let confirmAnswer = true;
/** Every `confirm_close` invoke — i.e. every quit the bridge actually allowed. */
const confirmed: string[] = [];

mock.module('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    hostHandlers.set(name, handler);
    return () => hostHandlers.delete(name);
  },
}));

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd === 'confirm_close') confirmed.push(cmd);
    return undefined;
  },
}));

mock.module('@tauri-apps/plugin-dialog', () => ({
  ask: async () => false,
  confirm: async () => confirmAnswer,
  message: async () => undefined,
  open: async () => null,
  save: async () => null,
}));

// Dynamic, because `mock.module` is not hoisted above static imports in bun.
const { createSleepSampler, startSystemEvents, resetSystemEventsForTest } = await import(
  './systemEvents'
);

const DIR = '/data';
const DATA = joinPath(DIR, 'data.json');

function makeTask(id: string, overrides: Record<string, unknown> = {}): AppData['tasks'][string] {
  return {
    id,
    title: '写周报',
    projectId: 'p1',
    tagIds: [],
    subTaskIds: [],
    isDone: false,
    isImportant: false,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    timeEntries: [],
    notes: '',
    created: 0,
    ...overrides,
  } as AppData['tasks'][string];
}

/** Counts how many times a full dataset landed on disk. */
class CountingFs extends MemoryFs {
  writes = 0;

  override async writeText(path: string, contents: string): Promise<void> {
    if (path.endsWith('.tmp')) this.writes += 1;
    return super.writeText(path, contents);
  }
}

interface Harness {
  store: DataStore;
  fs: CountingFs;
  start: (startedAt: number) => ActiveTimer;
}

interface BootOptions {
  isDone?: boolean;
  idlePauseEnabled?: boolean;
  idlePauseMinutes?: number;
}

/**
 * Boots the bridge over a store holding one task, and puts the timer store in
 * the state a running session produces. The renderer-side data store is seeded
 * from the same dataset, because the auto-pause path reads its settings from
 * there rather than from the store.
 */
async function boot(opts: BootOptions = {}): Promise<Harness> {
  const fs = new CountingFs();
  const store = await DataStore.open(DIR, fs);
  const data = {
    ...emptyAppData(),
    tasks: { t1: makeTask('t1', { isDone: opts.isDone ?? false }) },
    settings: {
      ...emptyAppData().settings,
      idlePauseEnabled: opts.idlePauseEnabled ?? true,
      idlePauseMinutes: opts.idlePauseMinutes ?? 5,
    },
  } as AppData;
  await store.save(data);

  // The bridge writes through `api().timerSync` for everything except the quit
  // settlement, which writes through the store directly. Only the latter's
  // effect is under test here, so the api surface can be minimal.
  installApi({ timerSync: async () => {} } as unknown as RendererApi);
  startSystemEvents(store);
  useDataStore.setState({ data });

  const start = (startedAt: number): ActiveTimer => {
    const timer: ActiveTimer = {
      taskId: 't1',
      startedAt,
      accumulatedMs: 0,
      isPaused: false,
      sessionStartedAt: startedAt,
    };
    useTimerStore.setState({ timer, now: startedAt });
    return timer;
  };
  return { store, fs, start };
}

/** Fires a host event the way the Rust shell would. */
function emitHost(channel: string, payload?: unknown): void {
  const handler = hostHandlers.get(channel);
  if (!handler) throw new Error(`nothing is listening on ${channel}`);
  handler({ payload });
}

/** Lets the bridge's awaited write paths finish before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

async function disk(fs: CountingFs): Promise<AppData> {
  return JSON.parse(await fs.readText(DATA)) as AppData;
}

beforeEach(() => {
  resetSystemEventsForTest();
  hostHandlers.clear();
  confirmed.length = 0;
  confirmAnswer = true;
  useTimerStore.setState({ timer: null, phasePendingAdvance: null });
  useDataStore.setState({ data: null });
});

describe('quit settlement', () => {
  test('moves the settled task and the cleared timer in one write', async () => {
    // ADR 0002 rejected the settle-then-clear pair for a concrete reason: an
    // interruption between the two writes leaves "the task is settled and
    // `activeTimer` still points at it" on disk, and recovery cannot tell that
    // apart from "the settle landed and the clear did not" — so it bills the
    // same session twice. The original's `settleActiveTimer` was one
    // `dataStore.update`; the count below is what holds that line here.
    const { fs, start } = await boot();
    const startedAt = Date.now() - 120_000;
    start(startedAt);
    fs.writes = 0;

    emitHost(HOST_EVENTS.closeRequested);
    await settle();

    const onDisk = await disk(fs);
    expect(onDisk.activeTimer).toBeNull();
    // A range rather than an exact figure: the settlement is taken from
    // `Date.now()`, so it lands a millisecond either side of 120_000 depending
    // on how long the confirmation took. Asserting the exact value would make
    // this a coin flip rather than a regression check.
    const spent = onDisk.tasks.t1?.timeSpent ?? 0;
    expect(spent).toBeGreaterThanOrEqual(120_000);
    expect(spent).toBeLessThan(120_000 + 5_000);
    expect(onDisk.tasks.t1?.timeEntries).toHaveLength(1);
    // One dataset write for "bill the task and drop the timer". Two is the
    // regression this test exists to catch.
    expect(fs.writes).toBe(1);
    expect(confirmed).toEqual(['confirm_close']);
  });

  test('clears without recording when the task is already done', async () => {
    // Its time may already have been settled by the completion write, and the
    // original refused to guess: settling again would bill it twice.
    const { fs, start } = await boot({ isDone: true });
    start(Date.now() - 90_000);
    fs.writes = 0;

    emitHost(HOST_EVENTS.closeRequested);
    await settle();

    const onDisk = await disk(fs);
    expect(onDisk.activeTimer).toBeNull();
    expect(onDisk.tasks.t1?.timeSpent).toBe(0);
    expect(onDisk.tasks.t1?.timeEntries).toHaveLength(0);
    expect(confirmed).toEqual(['confirm_close']);
  });

  test('a cancelled confirmation neither settles nor quits', async () => {
    const { fs, start } = await boot();
    start(Date.now() - 120_000);
    fs.writes = 0;
    confirmAnswer = false;

    emitHost(HOST_EVENTS.closeRequested);
    await settle();

    const onDisk = await disk(fs);
    expect(onDisk.tasks.t1?.timeSpent).toBe(0);
    expect(fs.writes).toBe(0);
    expect(confirmed).toEqual([]);
  });

  test('quits straight away when nothing is running', async () => {
    const { fs } = await boot();
    fs.writes = 0;

    emitHost(HOST_EVENTS.closeRequested);
    await settle();

    expect(fs.writes).toBe(0);
    expect(confirmed).toEqual(['confirm_close']);
  });

  test('the settled dataset reaches the renderer masked, like every other write', async () => {
    // The store holds the unredacted `apiKeyEncrypted`; pushing that into
    // renderer state would undo the masking the contract exists to provide.
    const { store, fs, start } = await boot();
    await store.update((d) => ({
      ...d,
      settings: {
        ...d.settings,
        aiProviders: [
          {
            id: 'p1',
            registryId: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKeyEncrypted: 'v2:super-secret-ciphertext',
            model: 'gpt-test',
            isDefault: true,
          },
        ],
      },
    }));
    useDataStore.setState({ data: await store.get() });
    start(Date.now() - 60_000);

    emitHost(HOST_EVENTS.closeRequested);
    await settle();

    const rendered = useDataStore.getState().data;
    expect(rendered?.settings.aiProviders[0]?.apiKeyEncrypted).toBe('');
    // And the ciphertext is still on disk — masked only for the renderer.
    const onDisk = await disk(fs);
    expect(onDisk.settings.aiProviders[0]?.apiKeyEncrypted).toBe('v2:super-secret-ciphertext');
  });
});

describe('idle auto-pause', () => {
  test('backdates by the measured idle time, so unattended minutes are not billed', async () => {
    const { start } = await boot({ idlePauseMinutes: 5 });
    // Worked for 10 minutes, then walked away. `startedAt` has to predate the
    // idle period, otherwise the backdate clamps onto it and there is nothing
    // left to distinguish — which is the correct behaviour, pinned separately.
    const workedMs = 10 * 60_000;
    const idleMs = 30 * 60_000;
    const startedAt = Date.now() - workedMs - idleMs;
    start(startedAt);

    emitHost(HOST_EVENTS.systemIdle, { seconds: idleMs / 1000 });
    await settle();

    const timer = useTimerStore.getState().timer;
    expect(timer?.isPaused).toBe(true);
    expect(timer?.autoPausedBy).toBe('idle');
    // The pause point sits at the start of the idle period, so the accumulated
    // elapsed is the 10 worked minutes — not 40. A small tolerance rather than
    // an exact figure: the backdate is subtracted from a fresh `Date.now()`, so
    // the result lands a millisecond either side depending on scheduling.
    const accumulated = timer?.accumulatedMs ?? 0;
    expect(accumulated).toBeGreaterThanOrEqual(workedMs);
    expect(accumulated).toBeLessThan(workedMs + 5_000);
    // And nowhere near the 40 minutes a pause taken at the reading would bill.
    expect(accumulated).toBeLessThan(workedMs + idleMs);
    const backdatedBy = Date.now() - (timer?.pausedAt ?? 0);
    expect(backdatedBy).toBeGreaterThanOrEqual(30 * 60_000);
    expect(backdatedBy).toBeLessThanOrEqual(30 * 60_000 + 5_000);
  });

  test('an idle period longer than the session bills nothing rather than going negative', async () => {
    // The clamp: the pause point cannot precede `startedAt`. A timer started
    // moments before a long idle has to settle at zero elapsed, not a negative.
    const { start } = await boot({ idlePauseMinutes: 5 });
    start(Date.now());

    emitHost(HOST_EVENTS.systemIdle, { seconds: 30 * 60 });
    await settle();

    const timer = useTimerStore.getState().timer;
    expect(timer?.isPaused).toBe(true);
    expect(timer?.accumulatedMs).toBe(0);
    expect(timer?.accumulatedMs ?? -1).toBeGreaterThanOrEqual(0);
  });

  test('an idle reading below the threshold does not pause', async () => {
    const { start } = await boot({ idlePauseMinutes: 5 });
    start(Date.now());

    emitHost(HOST_EVENTS.systemIdle, { seconds: 60 });
    await settle();

    expect(useTimerStore.getState().timer?.isPaused).toBe(false);
  });

  test('no idle reading pauses a timer when the user opted out of the feature', async () => {
    const { start } = await boot({ idlePauseEnabled: false, idlePauseMinutes: 5 });
    start(Date.now());

    // 99_999 seconds is far past any threshold; the setting is what stops it.
    emitHost(HOST_EVENTS.systemIdle, { seconds: 99_999 });
    await settle();

    expect(useTimerStore.getState().timer?.isPaused).toBe(false);
  });

  test('a nonsense reading is ignored rather than pausing an active timer', async () => {
    // CoreGraphics can report NaN around wake; treating that as "idle forever"
    // would stop a timer the user never let lapse.
    const { start } = await boot();
    start(Date.now());

    for (const seconds of [Number.NaN, -1]) {
      emitHost(HOST_EVENTS.systemIdle, { seconds });
    }
    await settle();

    expect(useTimerStore.getState().timer?.isPaused).toBe(false);
  });
});

describe('sleep watcher', () => {
  /**
   * Samples the watcher with a clock the test controls. The gap it reacts to is
   * a jump in `Date.now()`, which no amount of real waiting reproduces — the
   * interval would have to be waited out eight hours to see the regression.
   */
  function fakeClock(start: number): { now: () => number; jump: (ms: number) => void } {
    let current = start;
    return { now: () => current, jump: (ms: number) => (current += ms) };
  }

  test('an overnight suspend pauses the timer without billing the sleep', async () => {
    // The Critical this is all about. The watcher observes a suspend only at
    // wake, so a pause taken at the wake instant settles an eight-hour time
    // entry for a session that ran for ninety seconds. Asserted here as the
    // consequence — what the user would see on their task — rather than as the
    // backdate arithmetic, which `systemEventsLogic.test.ts` pins.
    const { start } = await boot();
    const workedMs = 90_000;
    const sleepMs = 8 * 3_600_000;
    const clock = fakeClock(1_000);
    // The session starts at the clock base, then the worked period is sampled
    // the way it would be in reality — every poll — so the sampler rebases on
    // time rather than seeing the whole 90s as one jump.
    start(clock.now());

    const sample = createSleepSampler(clock.now);
    for (let elapsed = 0; elapsed < workedMs; elapsed += SLEEP_POLL_MS) {
      clock.jump(SLEEP_POLL_MS);
      sample();
    }
    expect(useTimerStore.getState().timer?.isPaused).toBe(false);

    clock.jump(sleepMs); // lid shut; the next sample is the first to notice
    sample();
    await settle();

    const timer = useTimerStore.getState().timer;
    expect(timer?.isPaused).toBe(true);
    expect(timer?.autoPausedBy).toBe('sleep');
    // Ninety seconds of work, never the eight hours. The pause point is the
    // last sample before the jump, so the figure lands on the poll grid rather
    // than on the exact instant the lid shut.
    expect(timer?.accumulatedMs).toBe(workedMs);
  });

  test('an ordinary late tick leaves a running timer alone', async () => {
    // Under load a poll drifts by seconds. Treating drift as sleep would pause
    // the timer of anyone running a build.
    const { start } = await boot();
    const clock = fakeClock(1_000);
    start(clock.now());

    const sample = createSleepSampler(clock.now);
    clock.jump(SLEEP_POLL_MS + 2_000);
    sample();
    await settle();

    expect(useTimerStore.getState().timer?.isPaused).toBe(false);
  });

  test('two consecutive short gaps are not treated as a sleep', async () => {
    // The sampler rebases on every tick, so a machine that is merely busy
    // across several ticks never accumulates its drift into a false suspend.
    const { start } = await boot();
    const clock = fakeClock(1_000);
    start(clock.now());

    const sample = createSleepSampler(clock.now);
    for (let i = 0; i < 5; i += 1) {
      clock.jump(SLEEP_POLL_MS + 8_000); // 8s late, every tick
      sample();
    }
    await settle();

    expect(useTimerStore.getState().timer?.isPaused).toBe(false);
  });
});
