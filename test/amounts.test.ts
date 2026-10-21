import { describe, expect, it } from 'vitest';
import { actualFor, chargeAmount } from '../src/store/amounts.js';

const charge = { key: 'k', limits: {}, requests: 1, tokens: 300, inputTokens: 100, outputTokens: 200 };

describe('token amounts per window', () => {
  it('charges requests, totals, inputs and outputs to the matching windows', () => {
    expect(chargeAmount(charge, 'rpm')).toBe(1);
    expect(chargeAmount(charge, 'tpm')).toBe(300);
    expect(chargeAmount(charge, 'tpd')).toBe(300);
    expect(chargeAmount(charge, 'itpm')).toBe(100);
    expect(chargeAmount(charge, 'otpm')).toBe(200);
    // Without a split, input and output windows are charged the total (cautious).
    const plain = { key: 'k', limits: {}, requests: 1, tokens: 300 };
    expect(chargeAmount(plain, 'itpm')).toBe(300);
    expect(chargeAmount(plain, 'otpm')).toBe(300);
  });

  it('picks the real count for each window, or keeps the estimate', () => {
    const actual = { total: 90, input: 50, output: 40 };
    expect(actualFor('tpm', actual)).toBe(90);
    expect(actualFor('itpm', actual)).toBe(50);
    expect(actualFor('otpm', actual)).toBe(40);
    expect(actualFor('rpm', actual)).toBeUndefined();
    // A plain number is the total; input and output windows keep their estimates.
    expect(actualFor('tpd', 70)).toBe(70);
    expect(actualFor('otpm', 70)).toBeUndefined();
    expect(actualFor('tpm', undefined)).toBeUndefined();
    expect(actualFor('otpm', { total: 5 })).toBeUndefined();
  });
});
