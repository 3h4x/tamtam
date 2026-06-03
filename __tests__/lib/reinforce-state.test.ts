import { describe, it, expect, beforeEach } from 'vitest';
import {
  getReinforceState,
  bumpReinforceState,
  clearReinforceState,
} from '@/lib/workflows/triggers/reinforce-state';

describe('reinforce-state', () => {
  beforeEach(() => {
    clearReinforceState('proj');
    clearReinforceState('a');
    clearReinforceState('b');
  });

  it('starts with iterations 0 and lastSeenLoc -1', () => {
    expect(getReinforceState('proj')).toEqual({ iterations: 0, lastSeenLoc: -1 });
  });

  it('bump records iteration count and last seen loc', () => {
    bumpReinforceState('proj', 5);
    expect(getReinforceState('proj')).toEqual({ iterations: 1, lastSeenLoc: 5 });
    bumpReinforceState('proj', 9);
    expect(getReinforceState('proj')).toEqual({ iterations: 2, lastSeenLoc: 9 });
  });

  it('clear resets to defaults', () => {
    bumpReinforceState('proj', 5);
    clearReinforceState('proj');
    expect(getReinforceState('proj')).toEqual({ iterations: 0, lastSeenLoc: -1 });
  });

  it('isolates state per project', () => {
    bumpReinforceState('a', 3);
    expect(getReinforceState('b')).toEqual({ iterations: 0, lastSeenLoc: -1 });
  });
});
