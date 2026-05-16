import { describe, it, expect } from 'vitest';
import {
  BINDING_MODES,
  createBinding,
  isAgentControlled,
  isBindingMode,
} from './binding.js';

describe('AgentBinding', () => {
  describe('createBinding', () => {
    it('returns a frozen value with the three fields exposed', () => {
      const b = createBinding({
        entityId: 'e_123',
        ownerUid: 'user_abc',
        bindingMode: 'agent-only',
      });
      expect(b.entityId).toBe('e_123');
      expect(b.ownerUid).toBe('user_abc');
      expect(b.bindingMode).toBe('agent-only');
      expect(Object.isFrozen(b)).toBe(true);
    });

    it('accepts every valid bindingMode', () => {
      for (const mode of BINDING_MODES) {
        const b = createBinding({ entityId: 'e', ownerUid: 'u', bindingMode: mode });
        expect(b.bindingMode).toBe(mode);
      }
    });

    it('rejects empty entityId', () => {
      expect(() =>
        createBinding({ entityId: '', ownerUid: 'u', bindingMode: 'agent-only' }),
      ).toThrow(/entityId/);
    });

    it('rejects empty ownerUid', () => {
      expect(() =>
        createBinding({ entityId: 'e', ownerUid: '', bindingMode: 'agent-only' }),
      ).toThrow(/ownerUid/);
    });

    it('rejects unknown bindingMode', () => {
      expect(() =>
        createBinding({
          entityId: 'e',
          ownerUid: 'u',
          // @ts-expect-error — intentionally invalid
          bindingMode: 'spectator',
        }),
      ).toThrow(/bindingMode/);
    });

    it('rejects non-string entityId', () => {
      expect(() =>
        createBinding({
          // @ts-expect-error — intentionally invalid
          entityId: 42,
          ownerUid: 'u',
          bindingMode: 'agent-only',
        }),
      ).toThrow(/entityId/);
    });

    it('leaves room for NPC ownership (string prefix not constrained)', () => {
      // Future NPC bindings will use a server-reserved identity like `npc:<name>`.
      // The type today does not constrain the namespace — this test pins that
      // contract so refactors don't silently lock it down.
      const npc = createBinding({
        entityId: 'e_npc1',
        ownerUid: 'npc:village-merchant',
        bindingMode: 'agent-only',
      });
      expect(npc.ownerUid).toBe('npc:village-merchant');
    });
  });

  describe('isBindingMode', () => {
    it('accepts the canonical strings', () => {
      for (const m of BINDING_MODES) expect(isBindingMode(m)).toBe(true);
    });
    it('rejects everything else', () => {
      expect(isBindingMode('')).toBe(false);
      expect(isBindingMode('AGENT-ONLY')).toBe(false);
      expect(isBindingMode(null)).toBe(false);
      expect(isBindingMode(undefined)).toBe(false);
      expect(isBindingMode(0)).toBe(false);
      expect(isBindingMode({})).toBe(false);
    });
  });

  describe('isAgentControlled', () => {
    it('is true for agent-only', () => {
      expect(
        isAgentControlled(
          createBinding({ entityId: 'e', ownerUid: 'u', bindingMode: 'agent-only' }),
        ),
      ).toBe(true);
    });
    it('is true for hybrid (server treats it defensively as agent-only)', () => {
      expect(
        isAgentControlled(
          createBinding({ entityId: 'e', ownerUid: 'u', bindingMode: 'hybrid' }),
        ),
      ).toBe(true);
    });
    it('is false for player-direct', () => {
      expect(
        isAgentControlled(
          createBinding({ entityId: 'e', ownerUid: 'u', bindingMode: 'player-direct' }),
        ),
      ).toBe(false);
    });
  });
});
