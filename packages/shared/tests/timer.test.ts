import { describe, expect, test } from 'bun:test';
import type { ActiveTimer, Task } from '../src/models';
import {
  addDays,
  advancePomodoroPhase,
  applyEntryChange,
  applySettlement,
  autoPauseTimer,
  computeElapsed,
  computeFocusElapsed,
  computePhaseElapsed,
  idleThresholdReached,
  isPhaseComplete,
  isPomodoro,
  localDate,
  POMODORO_BREAK_MS,
  POMODORO_CYCLES_PER_SET,
  POMODORO_FOCUS_MS,
  pauseTimer,
  resumeTimer,
  settleTimer,
  startPomodoroFocus,
  startTimer,
} from '../src/timer';

const T0 = 1_785_700_000_000;

describe('timer transitions', () => {
  test('start creates fresh timer', () => {
    const t = startTimer('task1', T0);
    expect(t).toEqual({
      taskId: 'task1',
      startedAt: T0,
      accumulatedMs: 0,
      isPaused: false,
      sessionStartedAt: T0,
    });
  });

  test('pause accumulates elapsed time', () => {
    const t = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    expect(t.isPaused).toBe(true);
    expect(t.accumulatedMs).toBe(60_000);
    expect(t.pausedAt).toBe(T0 + 60_000);
  });

  test('pause is idempotent', () => {
    const t = startTimer('task1', T0);
    expect(pauseTimer(t, T0 + 1000)).toEqual(pauseTimer(pauseTimer(t, T0 + 1000), T0 + 9000));
  });

  test('resume restarts segment without losing accumulated time', () => {
    let t = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    t = resumeTimer(t, T0 + 120_000);
    expect(t.isPaused).toBe(false);
    expect(t.startedAt).toBe(T0 + 120_000);
    expect(t.accumulatedMs).toBe(60_000);
    expect(computeElapsed(t, T0 + 150_000)).toBe(90_000);
  });

  test('computeElapsed excludes paused time', () => {
    const t = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    expect(computeElapsed(t, T0 + 10 * 60_000)).toBe(60_000);
  });
});

describe('localDate', () => {
  test('formats local YYYY-MM-DD', () => {
    const d = new Date(2026, 7, 4, 9, 30); // Aug = month 7
    expect(localDate(d.getTime())).toBe('2026-08-04');
    expect(localDate(new Date(2026, 0, 1, 0, 0).getTime())).toBe('2026-01-01');
  });
});

describe('addDays', () => {
  test('adds one day', () => {
    expect(addDays('2026-08-04', 1)).toBe('2026-08-05');
  });
  test('rolls over month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  test('handles leap years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
  test('supports negative offsets', () => {
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31');
  });
});

describe('settlement', () => {
  test('settle running timer at now', () => {
    const t = startTimer('task1', T0);
    const s = settleTimer(t, T0 + 90_000);
    expect(s.ms).toBe(90_000);
    expect(s.entry.start).toBe(T0);
    expect(s.entry.end).toBe(T0 + 90_000);
    expect(s.entry.date).toBe(localDate(T0 + 90_000));
  });

  test('settle paused timer ends at pause time, not now', () => {
    const t = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    const s = settleTimer(t, T0 + 300_000);
    expect(s.ms).toBe(60_000);
    expect(s.entry.end).toBe(T0 + 60_000);
  });

  test('applySettlement adds ms to task totals and appends entry', () => {
    const task: Task = {
      id: 'task1',
      title: 'T',
      projectId: 'p',
      tagIds: [],
      subTaskIds: [],
      isDone: false,
      timeEstimate: 0,
      timeSpent: 10_000,
      timeSpentOnDay: { '2026-08-04': 5_000 },
      timeEntries: [],
      notes: '',
      created: 0,
    };
    const t = startTimer('task1', T0);
    const settled = applySettlement(task, settleTimer(t, T0 + 90_000));
    const day = localDate(T0 + 90_000);
    expect(settled.timeSpent).toBe(100_000);
    expect(settled.timeSpentOnDay[day]).toBe((day === '2026-08-04' ? 5_000 : 0) + 90_000);
    expect(settled.timeEntries).toHaveLength(1);
    expect(settled.timeEntries[0]?.ms).toBe(90_000);
    // original not mutated
    expect(task.timeSpent).toBe(10_000);
  });
});

describe('sessionStartedAt', () => {
  test('start records the session start', () => {
    expect(startTimer('task1', T0).sessionStartedAt).toBe(T0);
  });

  test('settle of a resumed session uses the session start, not the last segment', () => {
    let t = startTimer('task1', T0);
    t = pauseTimer(t, T0 + 60_000);
    t = resumeTimer(t, T0 + 300_000);
    const s = settleTimer(t, T0 + 360_000);
    expect(s.entry.start).toBe(T0);
    expect(s.entry.end).toBe(T0 + 360_000);
    expect(s.ms).toBe(120_000);
  });
});

describe('autoPauseTimer', () => {
  test('sleep pause stops the running segment at now with a reason', () => {
    const t = autoPauseTimer(startTimer('task1', T0), T0 + 60_000, 'sleep');
    expect(t.isPaused).toBe(true);
    expect(t.autoPausedBy).toBe('sleep');
    expect(t.accumulatedMs).toBe(60_000);
    expect(t.pausedAt).toBe(T0 + 60_000);
  });

  test('idle pause backdates so unattended time is not counted', () => {
    const t = autoPauseTimer(startTimer('task1', T0), T0 + 600_000, 'idle', 480_000);
    expect(t.isPaused).toBe(true);
    expect(t.autoPausedBy).toBe('idle');
    expect(t.accumulatedMs).toBe(120_000);
    expect(t.pausedAt).toBe(T0 + 120_000);
  });

  test('no-op when already paused', () => {
    const paused = pauseTimer(startTimer('task1', T0), T0 + 60_000);
    expect(autoPauseTimer(paused, T0 + 120_000, 'idle', 60_000)).toEqual(paused);
  });

  test('manual pause clears the auto-pause reason', () => {
    const auto = autoPauseTimer(startTimer('task1', T0), T0 + 60_000, 'sleep');
    const manual = pauseTimer(resumeTimer(auto, T0 + 90_000), T0 + 120_000);
    expect(manual.autoPausedBy).toBeUndefined();
  });
});

describe('applyEntryChange', () => {
  // 2026-08-04 23:50 local, so +20min crosses into 2026-08-05
  const lateNight = new Date(2026, 7, 4, 23, 50).getTime();
  const day1 = localDate(lateNight);
  const day2 = localDate(lateNight + 20 * 60_000);

  function baseTask(): Task {
    return {
      id: 'task1',
      title: 'T',
      projectId: 'p',
      tagIds: [],
      subTaskIds: [],
      isDone: false,
      timeEstimate: 0,
      timeSpent: 100_000,
      timeSpentOnDay: { [day1]: 100_000 },
      timeEntries: [{ date: day1, start: lateNight, end: lateNight + 100_000, ms: 100_000 }],
      notes: '',
      created: 0,
    };
  }

  test('editing an entry adjusts totals by the delta and replaces it', () => {
    const task = baseTask();
    const oldEntry = task.timeEntries[0]!;
    const newEntry = { ...oldEntry, end: oldEntry.end + 50_000, ms: 150_000 };
    const next = applyEntryChange(task, oldEntry, newEntry);
    expect(next.timeSpent).toBe(150_000);
    expect(next.timeSpentOnDay[day1]).toBe(150_000);
    expect(next.timeEntries).toEqual([newEntry]);
    // original not mutated
    expect(task.timeSpent).toBe(100_000);
  });

  test('editing across midnight moves time between days', () => {
    const task = baseTask();
    const oldEntry = task.timeEntries[0]!;
    const newStart = lateNight;
    const newEnd = lateNight + 20 * 60_000;
    const newEntry = { date: day2, start: newStart, end: newEnd, ms: newEnd - newStart };
    const next = applyEntryChange(task, oldEntry, newEntry);
    expect(next.timeSpent).toBe(newEntry.ms);
    expect(next.timeSpentOnDay[day1]).toBeUndefined();
    expect(next.timeSpentOnDay[day2]).toBe(newEntry.ms);
  });

  test('deleting an entry subtracts its time', () => {
    const task = baseTask();
    const next = applyEntryChange(task, task.timeEntries[0]!, null);
    expect(next.timeSpent).toBe(0);
    expect(next.timeSpentOnDay[day1]).toBeUndefined();
    expect(next.timeEntries).toEqual([]);
  });

  test('legacy timeSpent without entries is preserved on other-entry edits', () => {
    const task = baseTask();
    task.timeSpent = 999_999; // includes imported time not backed by entries
    const oldEntry = task.timeEntries[0]!;
    const next = applyEntryChange(task, oldEntry, null);
    expect(next.timeSpent).toBe(899_999);
  });

  test('totals never go negative', () => {
    const task = baseTask();
    task.timeSpent = 50_000; // inconsistent with entries
    task.timeSpentOnDay = { [day1]: 10_000 };
    const next = applyEntryChange(task, task.timeEntries[0]!, null);
    expect(next.timeSpent).toBe(0);
    expect(next.timeSpentOnDay[day1]).toBeUndefined();
  });
});

describe('idleThresholdReached', () => {
  const settings = { idlePauseEnabled: true, idlePauseMinutes: 5 };

  test('false when idle detection is disabled', () => {
    expect(idleThresholdReached({ ...settings, idlePauseEnabled: false }, 10 * 60_000)).toBe(false);
  });

  test('false below the threshold', () => {
    expect(idleThresholdReached(settings, 5 * 60_000 - 1)).toBe(false);
  });

  test('true at and above the threshold', () => {
    expect(idleThresholdReached(settings, 5 * 60_000)).toBe(true);
    expect(idleThresholdReached(settings, 60 * 60_000)).toBe(true);
  });
});

describe('pomodoro', () => {
  test('startPomodoroFocus sets focus phase and counter 0', () => {
    const t = startPomodoroFocus('task1', T0);
    expect(t.mode).toBe('pomodoro');
    expect(t.phase).toBe('focus');
    expect(t.phaseStartedAt).toBe(T0);
    expect(t.phaseAccumulatedMs).toBe(0);
    expect(t.phaseDurationMs).toBe(POMODORO_FOCUS_MS);
    expect(t.cyclesCompleted).toBe(0);
    expect(t.focusAccumulatedMs).toBe(0);
    expect(isPomodoro(t)).toBe(true);
  });

  test('isPomodoro returns false for free and legacy timers', () => {
    expect(isPomodoro(startTimer('task1', T0))).toBe(false);
    // legacy data without mode field
    expect(isPomodoro({ ...startTimer('task1', T0) } as ActiveTimer)).toBe(false);
  });

  test('isPhaseComplete flips true after the focus duration elapses', () => {
    const t = startPomodoroFocus('task1', T0);
    expect(isPhaseComplete(t, T0 + POMODORO_FOCUS_MS - 1)).toBe(false);
    expect(isPhaseComplete(t, T0 + POMODORO_FOCUS_MS)).toBe(true);
    expect(isPhaseComplete(t, T0 + POMODORO_FOCUS_MS + 60_000)).toBe(true);
  });

  test('computePhaseElapsed excludes paused time', () => {
    let t = startPomodoroFocus('task1', T0);
    // run 10 min, pause, wait 5 min, resume, run 3 min => phase elapsed = 13 min
    t = pauseTimer(t, T0 + 10 * 60_000);
    expect(computePhaseElapsed(t, T0 + 15 * 60_000)).toBe(10 * 60_000);
    t = resumeTimer(t, T0 + 15 * 60_000);
    expect(computePhaseElapsed(t, T0 + 18 * 60_000)).toBe(13 * 60_000);
  });

  test('pause folds phase clock the same way as segment clock', () => {
    const t = startPomodoroFocus('task1', T0);
    const paused = pauseTimer(t, T0 + 5 * 60_000);
    expect(paused.phaseAccumulatedMs).toBe(5 * 60_000);
    expect(paused.phaseStartedAt).toBe(T0 + 5 * 60_000);
    // Pause folds the focus delta so live computeFocusElapsed reports the
    // right value while paused. Resume rebases phaseStartedAt; advance folds
    // the next delta — no double counting.
    expect(paused.focusAccumulatedMs).toBe(5 * 60_000);
    // frozen during pause
    expect(computePhaseElapsed(paused, T0 + 30 * 60_000)).toBe(5 * 60_000);
    // resumes from where it left off
    const resumed = resumeTimer(paused, T0 + 6 * 60_000);
    expect(resumed.phaseAccumulatedMs).toBe(5 * 60_000);
    expect(resumed.phaseStartedAt).toBe(T0 + 6 * 60_000);
    expect(computePhaseElapsed(resumed, T0 + 9 * 60_000)).toBe(8 * 60_000);
  });

  test('pause on a free-mode timer does not touch phase fields', () => {
    const t = startTimer('task1', T0);
    const paused = pauseTimer(t, T0 + 30_000);
    expect(paused.phaseStartedAt).toBeUndefined();
    expect(paused.phaseAccumulatedMs).toBeUndefined();
  });

  test('advance focus→break increments cyclesCompleted and resets only the phase clock', () => {
    const t = startPomodoroFocus('task1', T0);
    const r = advancePomodoroPhase(t, T0 + POMODORO_FOCUS_MS);
    expect(r.setComplete).toBe(false);
    expect(r.finishedPhase).toBe('focus');
    expect(r.next.phase).toBe('break');
    expect(r.next.cyclesCompleted).toBe(1);
    expect(r.next.phaseDurationMs).toBe(POMODORO_BREAK_MS);
    expect(r.next.phaseStartedAt).toBe(T0 + POMODORO_FOCUS_MS);
    expect(r.next.phaseAccumulatedMs).toBe(0);
    // Session clock keeps running so the entire pomodoro span settles as one entry.
    expect(r.next.startedAt).toBe(T0);
    expect(r.next.accumulatedMs).toBe(0);
    expect(r.next.isPaused).toBe(false);
    // Folded into the focus-only accumulator so break time won't be logged.
    expect(r.next.focusAccumulatedMs).toBe(POMODORO_FOCUS_MS);
  });

  test('advance break→focus does not change cyclesCompleted', () => {
    let t = startPomodoroFocus('task1', T0);
    t = advancePomodoroPhase(t, T0 + POMODORO_FOCUS_MS).next; // → break, cycles=1
    const r = advancePomodoroPhase(t, T0 + POMODORO_FOCUS_MS + POMODORO_BREAK_MS);
    expect(r.setComplete).toBe(false);
    expect(r.finishedPhase).toBe('break');
    expect(r.next.phase).toBe('focus');
    expect(r.next.cyclesCompleted).toBe(1); // unchanged
    // Bug 2 fix: new focus phase is always 25 min, not the previous break's 5 min.
    expect(r.next.phaseDurationMs).toBe(POMODORO_FOCUS_MS);
  });

  test('after the 4th focus the timer pauses with setComplete=true', () => {
    let t = startPomodoroFocus('task1', T0);
    let now = T0;
    for (let i = 0; i < POMODORO_CYCLES_PER_SET - 1; i++) {
      now += POMODORO_FOCUS_MS;
      t = advancePomodoroPhase(t, now).next; // → break (i < 3)
      now += POMODORO_BREAK_MS;
      t = advancePomodoroPhase(t, now).next; // → focus
    }
    // We're now at the start of the 4th focus. Run it to completion.
    now += POMODORO_FOCUS_MS;
    const r = advancePomodoroPhase(t, now);
    expect(r.setComplete).toBe(true);
    expect(r.finishedPhase).toBe('focus');
    expect(r.next.phase).toBe('focus'); // stays on focus; renderer decides
    expect(r.next.cyclesCompleted).toBe(POMODORO_CYCLES_PER_SET);
    expect(r.next.isPaused).toBe(true);
    expect(r.next.pausedAt).toBe(now);
  });

  test('legacy timer (no mode field) ignores pomodoro helpers', () => {
    const legacy = startTimer('task1', T0);
    expect(isPhaseComplete(legacy, T0 + 1_000_000)).toBe(false);
    expect(computePhaseElapsed(legacy, T0 + 1_000_000)).toBe(0);
    const r = advancePomodoroPhase(legacy, T0 + 1_000_000);
    expect(r.next).toBe(legacy);
    expect(r.setComplete).toBe(false);
  });
});

describe('pomodoro focus-only accumulator (break time excluded)', () => {
  test('one full cycle (focus→break) settles to 25 min, not 30 min', () => {
    let t = startPomodoroFocus('task1', T0);
    t = advancePomodoroPhase(t, T0 + POMODORO_FOCUS_MS).next; // → break
    const s = settleTimer(t, T0 + POMODORO_FOCUS_MS + 3 * 60_000); // 3 min into break
    expect(s.ms).toBe(POMODORO_FOCUS_MS);
  });

  test('two full cycles settle to 50 min', () => {
    let t = startPomodoroFocus('task1', T0);
    t = advancePomodoroPhase(t, T0 + POMODORO_FOCUS_MS).next; // → break
    t = advancePomodoroPhase(t, T0 + POMODORO_FOCUS_MS + POMODORO_BREAK_MS).next; // → focus
    t = advancePomodoroPhase(t, T0 + 2 * POMODORO_FOCUS_MS + POMODORO_BREAK_MS).next; // → break
    const s = settleTimer(t, T0 + 2 * POMODORO_FOCUS_MS + POMODORO_BREAK_MS + 2 * 60_000);
    expect(s.ms).toBe(2 * POMODORO_FOCUS_MS);
  });

  test('four full cycles (set complete) settle to 100 min', () => {
    let t = startPomodoroFocus('task1', T0);
    let now = T0;
    for (let i = 0; i < POMODORO_CYCLES_PER_SET; i++) {
      now += POMODORO_FOCUS_MS;
      t = advancePomodoroPhase(t, now).next;
      if (i < POMODORO_CYCLES_PER_SET - 1) {
        now += POMODORO_BREAK_MS;
        t = advancePomodoroPhase(t, now).next;
      }
    }
    expect(t.cyclesCompleted).toBe(POMODORO_CYCLES_PER_SET);
    const s = settleTimer(t, now + 60_000);
    expect(s.ms).toBe(4 * POMODORO_FOCUS_MS);
  });

  test('pause during focus then resume then break: break still excluded', () => {
    let t = startPomodoroFocus('task1', T0);
    // run 5 min focus, pause, wait 1 min, resume, run 10 more min, advance, 3 min break
    t = pauseTimer(t, T0 + 5 * 60_000);
    t = resumeTimer(t, T0 + 6 * 60_000);
    t = advancePomodoroPhase(t, T0 + 16 * 60_000).next; // → break after 15 min total focus
    const s = settleTimer(t, T0 + 16 * 60_000 + 3 * 60_000);
    expect(s.ms).toBe(15 * 60_000);
  });

  test('stop mid-focus: only current focus elapsed counts', () => {
    const t = startPomodoroFocus('task1', T0);
    const s = settleTimer(t, T0 + 10 * 60_000);
    expect(s.ms).toBe(10 * 60_000);
  });

  test('stop mid-break: only completed focus sessions count', () => {
    let t = startPomodoroFocus('task1', T0);
    t = advancePomodoroPhase(t, T0 + POMODORO_FOCUS_MS).next; // → break
    const s = settleTimer(t, T0 + POMODORO_FOCUS_MS + 3 * 60_000);
    expect(s.ms).toBe(POMODORO_FOCUS_MS);
  });

  test('pause during break does not affect logged focus time', () => {
    let t = startPomodoroFocus('task1', T0);
    t = advancePomodoroPhase(t, T0 + POMODORO_FOCUS_MS).next; // → break
    t = pauseTimer(t, T0 + POMODORO_FOCUS_MS + 2 * 60_000);
    t = resumeTimer(t, T0 + POMODORO_FOCUS_MS + 12 * 60_000);
    const s = settleTimer(t, T0 + POMODORO_FOCUS_MS + 13 * 60_000);
    expect(s.ms).toBe(POMODORO_FOCUS_MS);
  });

  test('multi-set: focusAccumulatedMs is preserved across "another set"', () => {
    // Simulate the renderer's startNextPomodoroSet semantics: keep
    // focusAccumulatedMs, reset phase clock and counter.
    function startNextSet(cur: ActiveTimer, now: number): ActiveTimer {
      return {
        ...cur,
        phase: 'focus',
        phaseStartedAt: now,
        phaseAccumulatedMs: 0,
        phaseDurationMs: POMODORO_FOCUS_MS,
        cyclesCompleted: 0,
        isPaused: false,
        pausedAt: undefined,
      };
    }
    // Run 4 full cycles to set complete.
    let t = startPomodoroFocus('task1', T0);
    let now = T0;
    for (let i = 0; i < POMODORO_CYCLES_PER_SET; i++) {
      now += POMODORO_FOCUS_MS;
      t = advancePomodoroPhase(t, now).next;
      if (i < POMODORO_CYCLES_PER_SET - 1) {
        now += POMODORO_BREAK_MS;
        t = advancePomodoroPhase(t, now).next;
      }
    }
    expect(t.cyclesCompleted).toBe(POMODORO_CYCLES_PER_SET);
    // "Another set" — now in a fresh focus, run 25 more min, then settle.
    const resumeAt = now;
    t = startNextSet(t, resumeAt);
    expect(t.focusAccumulatedMs).toBe(4 * POMODORO_FOCUS_MS);
    t = advancePomodoroPhase(t, resumeAt + POMODORO_FOCUS_MS).next; // → break
    const s = settleTimer(t, resumeAt + POMODORO_FOCUS_MS + 60_000);
    expect(s.ms).toBe(5 * POMODORO_FOCUS_MS);
  });

  test('free-mode settle is unchanged (regression guard)', () => {
    const t = startTimer('task1', T0);
    const s = settleTimer(t, T0 + 90_000);
    expect(s.ms).toBe(90_000);
  });

  test('computeFocusElapsed live during running focus', () => {
    const t = startPomodoroFocus('task1', T0);
    expect(computeFocusElapsed(t, T0 + 7 * 60_000)).toBe(7 * 60_000);
    const paused = pauseTimer(t, T0 + 7 * 60_000);
    expect(computeFocusElapsed(paused, T0 + 30 * 60_000)).toBe(7 * 60_000);
    const resumed = resumeTimer(paused, T0 + 30 * 60_000);
    expect(computeFocusElapsed(resumed, T0 + 33 * 60_000)).toBe(10 * 60_000);
  });

  test('computeFocusElapsed freezes during break', () => {
    let t = startPomodoroFocus('task1', T0);
    t = advancePomodoroPhase(t, T0 + POMODORO_FOCUS_MS).next; // → break
    expect(computeFocusElapsed(t, T0 + POMODORO_FOCUS_MS + 3 * 60_000)).toBe(POMODORO_FOCUS_MS);
  });

  test('computeFocusElapsed falls back to computeElapsed for free timers', () => {
    const t = startTimer('task1', T0);
    expect(computeFocusElapsed(t, T0 + 30_000)).toBe(30_000);
  });
});

describe('pomodoro phase alternation (Bug 2 regression)', () => {
  test('phase durations alternate focus 25 / break 5 across 4 cycles', () => {
    let t = startPomodoroFocus('task1', T0);
    expect(t.phaseDurationMs).toBe(POMODORO_FOCUS_MS);
    let now = T0;
    for (let i = 0; i < POMODORO_CYCLES_PER_SET - 1; i++) {
      now += POMODORO_FOCUS_MS;
      const focusToBreak = advancePomodoroPhase(t, now);
      expect(focusToBreak.setComplete).toBe(false);
      expect(focusToBreak.next.phase).toBe('break');
      expect(focusToBreak.next.phaseDurationMs).toBe(POMODORO_BREAK_MS);
      now += POMODORO_BREAK_MS;
      const breakToFocus = advancePomodoroPhase(focusToBreak.next, now);
      expect(breakToFocus.next.phase).toBe('focus');
      // Bug 2 fix: new focus is always 25 min, not 5 min.
      expect(breakToFocus.next.phaseDurationMs).toBe(POMODORO_FOCUS_MS);
      expect(breakToFocus.next.cyclesCompleted).toBe(i + 1);
      t = breakToFocus.next;
    }
    // 4th focus → break triggers setComplete; phase stays on focus.
    now += POMODORO_FOCUS_MS;
    const finalAdvance = advancePomodoroPhase(t, now);
    expect(finalAdvance.setComplete).toBe(true);
    expect(finalAdvance.next.phase).toBe('focus');
    expect(finalAdvance.next.cyclesCompleted).toBe(POMODORO_CYCLES_PER_SET);
  });

  test('startNextPomodoroSet semantics: new focus is 25 min, not 5 min', () => {
    // The renderer's startNextPomodoroSet logic — replicated here in pure
    // form so the test does not need the renderer store.
    function startNextSet(cur: ActiveTimer, now: number): ActiveTimer {
      return {
        ...cur,
        phase: 'focus',
        phaseStartedAt: now,
        phaseAccumulatedMs: 0,
        phaseDurationMs: POMODORO_FOCUS_MS,
        cyclesCompleted: 0,
        isPaused: false,
        pausedAt: undefined,
      };
    }
    // Construct a timer right after setComplete: focus phase, cycles=4, but
    // (per the old bug) phaseDurationMs=5 from the previous break.
    const afterSetComplete: ActiveTimer = {
      taskId: 'task1',
      startedAt: T0,
      accumulatedMs: 4 * POMODORO_FOCUS_MS,
      isPaused: true,
      pausedAt: T0 + 4 * POMODORO_FOCUS_MS + 3 * POMODORO_BREAK_MS,
      sessionStartedAt: T0,
      mode: 'pomodoro',
      phase: 'focus',
      phaseStartedAt: T0 + 4 * POMODORO_FOCUS_MS + 3 * POMODORO_BREAK_MS,
      phaseAccumulatedMs: POMODORO_FOCUS_MS,
      phaseDurationMs: 5 * 60_000, // simulates the pre-fix bug artifact
      cyclesCompleted: 4,
      focusAccumulatedMs: 4 * POMODORO_FOCUS_MS,
    };
    const next = startNextSet(afterSetComplete, T0 + 4 * POMODORO_FOCUS_MS + 3 * POMODORO_BREAK_MS);
    expect(next.phaseDurationMs).toBe(POMODORO_FOCUS_MS);
  });
});
