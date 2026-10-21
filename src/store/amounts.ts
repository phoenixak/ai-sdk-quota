import type { Dimension } from '../types.js';
import { isTokenDimension, tokenKind } from '../windows.js';
import type { ActualTokens, Charge } from './types.js';

/** What a charge counts against one window. */
export function chargeAmount(charge: Charge, dim: Dimension): number {
  if (!isTokenDimension(dim)) return charge.requests;
  const kind = tokenKind(dim);
  return kind === 'input' ? (charge.inputTokens ?? charge.tokens) : kind === 'output' ? (charge.outputTokens ?? charge.tokens) : charge.tokens;
}

/** The real amount for one window after a call, or undefined to keep the estimate. */
export function actualFor(dim: Dimension, actual: ActualTokens | undefined): number | undefined {
  if (actual === undefined || !isTokenDimension(dim)) return undefined;
  const kind = tokenKind(dim);
  if (typeof actual === 'number') return kind === 'total' ? actual : undefined;
  return actual[kind];
}
