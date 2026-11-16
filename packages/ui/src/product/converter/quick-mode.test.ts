import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./source-rules-editor", () => ({ SourceRulesEditor: () => null }));

vi.mock("./quick-mode/sources-section", () => ({
  SourcesSection: () => React.createElement("div", null, "sources-section"),
}));

vi.mock("./quick-mode/templates-section", () => ({
  TemplatesSection: () => React.createElement("div", null, "templates-section"),
}));

import { QuickMode } from "./quick-mode";

describe("QuickMode", () => {
  it("renders sources before templates", () => {
    const html = renderToStaticMarkup(React.createElement(QuickMode));

    expect(html).toContain("sources-section");
    expect(html).toContain("templates-section");
    expect(html.indexOf("sources-section")).toBeLessThan(html.indexOf("templates-section"));
  });
});
