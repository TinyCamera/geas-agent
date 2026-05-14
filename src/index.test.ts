import { describe, it, expect } from "vitest";
import { getBanner } from "./index.js";

describe("geas-agent scaffold smoke", () => {
  it("returns the placeholder banner", () => {
    expect(getBanner()).toBe("geas-agent online — scaffold only");
  });
});
