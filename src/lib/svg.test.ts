import { describe, expect, it } from "vitest";

import { escapeSvgText } from "./svg";

describe("escapeSvgText", () => {
  it("escapes xml-sensitive characters", () => {
    expect(escapeSvgText(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });
});
