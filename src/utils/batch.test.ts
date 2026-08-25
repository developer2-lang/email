import { describe, it, expect } from 'vitest';
import { computeBatchSizes, computeTotalBatches } from '../../supabase/functions/_shared/batch.ts';

describe('computeBatchSizes', () => {
  it('splits 500 recipients into 17 batches (last = 20)', () => {
    const sizes = computeBatchSizes(500, 30);
    expect(sizes.length).toBe(17);
    expect(sizes.slice(0, 16).every((s) => s === 30)).toBe(true);
    expect(sizes[16]).toBe(20);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(500);
  });

  it('splits 60 recipients into 2 batches of 30', () => {
    const sizes = computeBatchSizes(60, 30);
    expect(sizes).toEqual([30, 30]);
    expect(computeTotalBatches(60, 30)).toBe(2);
  });

  it('a smaller audience than the batch size sends exactly once (no empty batch)', () => {
    const sizes = computeBatchSizes(20, 30);
    expect(sizes).toEqual([20]);
    expect(computeTotalBatches(20, 30)).toBe(1);
  });

  it('splits 75 recipients into 30, 30, 15', () => {
    const sizes = computeBatchSizes(75, 30);
    expect(sizes).toEqual([30, 30, 15]);
    expect(computeTotalBatches(75, 30)).toBe(3);
  });

  it('honors the selected audience size (New Lead = 70 → 3 batches)', () => {
    // The audience is resolved FIRST; batching only operates on those recipients.
    const sizes = computeBatchSizes(70, 30);
    expect(sizes).toEqual([30, 30, 10]);
    expect(computeTotalBatches(70, 30)).toBe(3);
  });

  it('never creates an empty trailing batch', () => {
    for (const [total, size] of [
      [1, 30],
      [30, 30],
      [31, 30],
      [0, 30],
      [1000, 1],
    ] as const) {
      const sizes = computeBatchSizes(total, size);
      expect(sizes.every((s) => s > 0)).toBe(true);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('clamps a missing/invalid batch size to a safe default of 30', () => {
    expect(computeTotalBatches(500, 0 as unknown as number)).toBe(17);
    expect(computeTotalBatches(500, undefined as unknown as number)).toBe(17);
  });

  it('returns an empty array for an empty audience (no batches to send)', () => {
    expect(computeBatchSizes(0, 30)).toEqual([]);
    expect(computeTotalBatches(0, 30)).toBe(0);
  });
});
