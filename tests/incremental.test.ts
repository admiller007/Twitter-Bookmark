import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KNOWN_THRESHOLD,
  advanceKnownStreak,
  shouldStopIncremental,
} from '../src/background/incremental';
import type { MergeOutcome } from '../src/database/schema';

const batch = (...outcomes: MergeOutcome[]): Array<{ outcome: MergeOutcome }> =>
  outcomes.map((outcome) => ({ outcome }));

describe('advanceKnownStreak', () => {
  it('counts already-known bookmarks', () => {
    expect(advanceKnownStreak(0, batch('unchanged', 'unchanged'))).toBe(2);
  });

  it('counts an updated bookmark as known, since its id was already stored', () => {
    expect(advanceKnownStreak(0, batch('unchanged', 'updated', 'unchanged'))).toBe(3);
  });

  it('resets on any unseen bookmark', () => {
    expect(advanceKnownStreak(30, batch('new'))).toBe(0);
  });

  it('resets mid-batch and resumes counting after the new bookmark', () => {
    expect(advanceKnownStreak(12, batch('unchanged', 'new', 'unchanged', 'unchanged'))).toBe(2);
  });

  it('carries the streak across batches', () => {
    let streak = 0;
    streak = advanceKnownStreak(streak, batch('unchanged', 'unchanged'));
    streak = advanceKnownStreak(streak, batch('unchanged'));
    expect(streak).toBe(3);
  });

  it('is unchanged by an empty batch', () => {
    expect(advanceKnownStreak(7, [])).toBe(7);
  });
});

describe('shouldStopIncremental', () => {
  it('does not stop on a single known bookmark', () => {
    expect(shouldStopIncremental('incremental', 1, DEFAULT_KNOWN_THRESHOLD)).toBe(false);
    expect(shouldStopIncremental('incremental', 39, 40)).toBe(false);
  });

  it('stops once the threshold is reached', () => {
    expect(shouldStopIncremental('incremental', 40, 40)).toBe(true);
    expect(shouldStopIncremental('incremental', 41, 40)).toBe(true);
  });

  it('never stops early during a full rescan', () => {
    expect(shouldStopIncremental('full', 10_000, 40)).toBe(false);
  });

  it('treats a zero or negative threshold as one', () => {
    expect(shouldStopIncremental('incremental', 1, 0)).toBe(true);
    expect(shouldStopIncremental('incremental', 0, 0)).toBe(false);
  });

  it('defaults to a conservative threshold', () => {
    expect(DEFAULT_KNOWN_THRESHOLD).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_KNOWN_THRESHOLD).toBeLessThanOrEqual(50);
  });
});
