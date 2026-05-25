import { describe, expect, it } from 'vitest';
import { REJECT_ALL_VERIFIER, StaticDevVerifier } from './auth.js';

describe('StaticDevVerifier', () => {
  it('maps known tokens to uids', async () => {
    const v = new StaticDevVerifier([
      ['tok-a', 'uid-a'],
      ['tok-b', 'uid-b'],
    ]);
    expect((await v.verify('tok-a')).uid).toBe('uid-a');
    expect((await v.verify('tok-b')).uid).toBe('uid-b');
  });

  it('rejects unknown tokens', async () => {
    const v = new StaticDevVerifier([['tok-a', 'uid-a']]);
    await expect(v.verify('bad')).rejects.toThrow(/invalid token/);
  });
});

describe('REJECT_ALL_VERIFIER', () => {
  it('always rejects', async () => {
    await expect(REJECT_ALL_VERIFIER.verify('whatever')).rejects.toThrow();
  });
});
