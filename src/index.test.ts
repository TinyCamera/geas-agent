import { describe, it, expect } from 'vitest';
import { getBanner, GeasMcpClient, GEAS_TOOL_NAMES } from './index.js';

describe('geas-agent entrypoint', () => {
  it('exports the banner', () => {
    expect(getBanner()).toMatch(/MCP client ready/);
  });

  it('exports the GeasMcpClient class', () => {
    expect(typeof GeasMcpClient).toBe('function');
  });

  it('exports the canonical tool name list', () => {
    expect(GEAS_TOOL_NAMES).toContain('look');
    expect(GEAS_TOOL_NAMES).toContain('act');
    expect(GEAS_TOOL_NAMES.length).toBeGreaterThan(10);
  });
});
