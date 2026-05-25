/**
 * Unit tests for the pre-dispatch validator (#658).
 *
 * Table-driven over the cheap-model failure modes: unknown tool, missing
 * required, wrong type, extras (warn-not-fail), and reserved-key passthrough.
 */

import { describe, it, expect } from 'vitest';
import {
  validateToolCall,
  buildSchemaCache,
  type ToolInputSchema,
} from './validator.js';

const ACT_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string' },
    dx: { type: 'integer' },
    dy: { type: 'integer' },
    targetId: { type: 'string' },
  },
  required: ['intent'],
};

const LOOK_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {},
};

const NEAREST_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    maxDist: { type: 'number' },
    aliveOnly: { type: 'boolean' },
    excludeBoss: { type: 'boolean' },
  },
};

const ALLOCATE_STATS_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {
    str: { type: 'integer' },
    agi: { type: 'integer' },
    int: { type: 'integer' },
    cha: { type: 'integer' },
  },
};

function schemaMap(): Map<string, ToolInputSchema> {
  return new Map<string, ToolInputSchema>([
    ['look', LOOK_SCHEMA],
    ['act', ACT_SCHEMA],
    ['nearest', NEAREST_SCHEMA],
    ['allocate_stats', ALLOCATE_STATS_SCHEMA],
  ]);
}

interface Case {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  expect:
    | { ok: true; extras?: string[] }
    | { ok: false; kind: 'unknown_tool' | 'missing_required' | 'wrong_type'; argMatch?: string[] };
}

const CASES: Case[] = [
  // --- happy path -----------------------------------------------------------
  {
    name: 'valid no-arg call (look)',
    tool: 'look',
    args: {},
    expect: { ok: true },
  },
  {
    name: 'valid act call with all declared args',
    tool: 'act',
    args: { intent: 'move', dx: 1, dy: 0 },
    expect: { ok: true },
  },
  {
    name: 'valid nearest with optional args only',
    tool: 'nearest',
    args: { type: 'goblin', maxDist: 8, aliveOnly: true },
    expect: { ok: true },
  },
  {
    name: 'reserved _agentBinding envelope is not flagged as extra',
    tool: 'look',
    args: {
      _agentBinding: { entityId: 'e1', ownerUid: 'u', bindingMode: 'soulbound' },
    },
    expect: { ok: true, extras: [] },
  },

  // --- unknown tool ---------------------------------------------------------
  {
    name: 'misspelled tool name (lok)',
    tool: 'lok',
    args: {},
    expect: { ok: false, kind: 'unknown_tool' },
  },
  {
    name: 'made-up tool name',
    tool: 'cast_spell',
    args: { name: 'fireball' },
    expect: { ok: false, kind: 'unknown_tool' },
  },

  // --- missing required -----------------------------------------------------
  {
    name: 'act missing required intent',
    tool: 'act',
    args: { dx: 1, dy: 0 },
    expect: { ok: false, kind: 'missing_required', argMatch: ['intent'] },
  },
  {
    name: 'act intent explicitly undefined still missing',
    tool: 'act',
    args: { intent: undefined, dx: 1 },
    expect: { ok: false, kind: 'missing_required', argMatch: ['intent'] },
  },

  // --- wrong type -----------------------------------------------------------
  {
    name: 'act intent must be string, given number',
    tool: 'act',
    args: { intent: 42 },
    expect: { ok: false, kind: 'wrong_type', argMatch: ['intent'] },
  },
  {
    name: 'act dx must be integer, given float',
    tool: 'act',
    args: { intent: 'move', dx: 1.5 },
    expect: { ok: false, kind: 'wrong_type', argMatch: ['dx'] },
  },
  {
    name: 'nearest aliveOnly must be boolean, given string',
    tool: 'nearest',
    args: { aliveOnly: 'yes' },
    expect: { ok: false, kind: 'wrong_type', argMatch: ['aliveOnly'] },
  },
  {
    name: 'allocate_stats str must be integer, given string',
    tool: 'allocate_stats',
    args: { str: '3' },
    expect: { ok: false, kind: 'wrong_type', argMatch: ['str'] },
  },

  // --- extras: warn, don't fail --------------------------------------------
  {
    name: 'extra arg returns ok with extras list populated',
    tool: 'act',
    args: { intent: 'move', dx: 1, dy: 0, surprise: 'new field' },
    expect: { ok: true, extras: ['surprise'] },
  },
  {
    name: 'extras coexist with reserved binding key',
    tool: 'act',
    args: {
      intent: 'move',
      surprise: 1,
      _agentBinding: { entityId: 'e', ownerUid: 'u', bindingMode: 'soulbound' },
    },
    expect: { ok: true, extras: ['surprise'] },
  },
];

describe('validateToolCall', () => {
  const schemas = schemaMap();
  for (const c of CASES) {
    it(c.name, () => {
      const res = validateToolCall(c.tool, c.args, schemas);
      if (c.expect.ok) {
        expect(res.ok).toBe(true);
        if (res.ok && c.expect.extras !== undefined) {
          expect(res.extras.sort()).toEqual([...c.expect.extras].sort());
        }
      } else {
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.kind).toBe(c.expect.kind);
          expect(res.message.length).toBeGreaterThan(0);
          if (c.expect.argMatch) {
            expect(res.args).toEqual(c.expect.argMatch);
          }
        }
      }
    });
  }

  it('returns ok when the schema cache is empty (no surface yet)', () => {
    const res = validateToolCall('look', {}, new Map());
    expect(res.ok).toBe(true);
  });

  it('skips type checks when the declared property has no `type`', () => {
    const s = new Map<string, ToolInputSchema>([
      [
        'oddball',
        {
          type: 'object',
          properties: { value: { /* no type — e.g. anyOf upstream */ } },
        },
      ],
    ]);
    const res = validateToolCall('oddball', { value: { whatever: 1 } }, s);
    expect(res.ok).toBe(true);
  });

  it('accepts union types via array `type`', () => {
    const s = new Map<string, ToolInputSchema>([
      [
        'flex',
        {
          type: 'object',
          properties: { qty: { type: ['integer', 'string'] } },
          required: [],
        },
      ],
    ]);
    expect(validateToolCall('flex', { qty: 3 }, s).ok).toBe(true);
    expect(validateToolCall('flex', { qty: 'all' }, s).ok).toBe(true);
    const bad = validateToolCall('flex', { qty: true }, s);
    expect(bad.ok).toBe(false);
  });

  it('reports both missing args in a single error', () => {
    const s = new Map<string, ToolInputSchema>([
      [
        'two',
        {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'string' } },
          required: ['a', 'b'],
        },
      ],
    ]);
    const res = validateToolCall('two', {}, s);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('missing_required');
      expect(res.args).toEqual(['a', 'b']);
    }
  });
});

describe('buildSchemaCache', () => {
  it('keeps the inputSchema for each tool', () => {
    const cache = buildSchemaCache([
      { name: 'a', inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } },
      { name: 'b' },
    ]);
    expect(cache.get('a')?.required).toEqual(['x']);
    // missing inputSchema → no-op schema (any args ok)
    expect(cache.get('b')?.type).toBe('object');
  });

  it('handles non-object inputSchema gracefully', () => {
    const cache = buildSchemaCache([
      { name: 'c', inputSchema: null as unknown },
      { name: 'd', inputSchema: 'broken' as unknown },
    ]);
    expect(cache.get('c')?.type).toBe('object');
    expect(cache.get('d')?.type).toBe('object');
  });
});
