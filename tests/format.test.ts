import { describe, expect, test } from "bun:test";
import { makeRelayStyle } from "../web/src/lib/relayStyle";
import { formatCompact, formatRatio, formatShortDate, formatUsd, formatUsdAxis, formatUsdDelta, shortPath } from "../web/src/lib/format";

describe("one number format", () => {
  test("money is $X.XX, $X.XXk past $1k, two significant figures under a cent", () => {
    expect(formatUsd(49.027537)).toBe("$49.03");
    expect(formatUsd(1587.63)).toBe("$1.59k");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0012345)).toBe("$0.0012");
    expect(formatUsd(0.000045)).toBe("$0.000045");
    expect(formatUsd(-47.272436)).toBe("-$47.27");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsdDelta(3)).toBe("+$3.00");
    expect(formatUsdAxis(653)).toBe("$653");
    expect(formatUsdAxis(2086.18)).toBe("$2.09k");
  });
  test("tokens are compact, ratios have at most two decimals", () => {
    expect(formatCompact(117_746_480)).toBe("117.7M");
    expect(formatRatio(13.914)).toBe("13.91×");
    expect(formatRatio(4)).toBe("4×");
  });
  test("paths keep two segments and dates are short", () => {
    expect(shortPath("/Users/me/work/app")).toBe("work/app");
    expect(shortPath("/solo")).toBe("solo");
    expect(formatShortDate("2026-10-13")).toBe("Oct 13");
  });
});

describe("series colours", () => {
  test("Other and not-recorded share one grey that no model can take", () => {
    for (const dark of [false, true]) {
      const models = Array.from({ length: 12 }, (_, index) => `model-${index}`);
      const style = makeRelayStyle(dark, models);
      const grey = style.modelColor("Other");
      expect(style.modelColor("Not recorded")).toBe(grey);
      expect(models.map(style.modelColor)).not.toContain(grey);
    }
  });
});
