import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoonCompatibilityNotice } from "./loon-compatibility-notice";

describe("Loon compatibility notice", () => {
  it.each([
    ["unsupported-protocol", "Loon 不支持此协议"],
    ["unsupported-transport", "Loon 不支持此传输方式"],
    ["unsupported-http-upgrade", "Loon 不支持 HTTP Upgrade"],
    ["unsupported-client-fingerprint", "Loon 不支持此客户端指纹"],
    ["unsupported-settings", "当前参数无法转换"],
  ])("explains %s without exposing raw errors", (reason, message) => {
    const config = `# SUBBOOST-LOON-COMPAT v1 included=0 skipped=1\n# SUBBOOST-LOON-SKIP v1 index=1 protocol=unknown transport=unknown reason=${reason}`;
    const html = renderToStaticMarkup(React.createElement(LoonCompatibilityNotice, { config }));
    expect(html).toContain(message);
    expect(html).toContain("可导出 0 个节点，跳过 1 个不兼容节点");
  });
  it("keeps counts visible and folds a long node and group list", () => {
    const config = [
      "# SUBBOOST-LOON-COMPAT v1 included=20 skipped=43",
      ...Array.from({ length: 43 }, (_, index) => `# SUBBOOST-LOON-SKIP v1 index=${index + 1} protocol=vmess transport=none reason=unsupported-settings`),
      "# SUBBOOST-LOON-GROUPS v1 skipped=3",
      ...[2, 5, 8].map((index) => `# SUBBOOST-LOON-GROUP-SKIP v1 index=${index} reason=no-compatible-outbound`),
    ].join("\n");
    const html = renderToStaticMarkup(React.createElement(LoonCompatibilityNotice, { config }));
    expect(html).toContain("可导出 20 个节点，跳过 43 个不兼容节点");
    expect(html).toContain("移除 3 个没有兼容出站的策略组");
    expect(html).toContain("<details><summary>查看跳过详情</summary>");
    expect(html).toContain("第 43 个节点：当前参数无法转换");
    expect(html).toContain("第 8 个策略组因没有兼容出站而移除");
    expect(html).not.toContain("Loon 不支持此协议");
  });

  it("does not add a notice to fully compatible success", () => {
    expect(renderToStaticMarkup(React.createElement(LoonCompatibilityNotice, { config: "# SUBBOOST-LOON-COMPAT v1 included=2 skipped=0" }))).toBe("");
  });
  it("does not add a notice to legacy text without a report", () => {
    expect(renderToStaticMarkup(React.createElement(LoonCompatibilityNotice, { config: "[General]\n[Rule]" }))).toBe("");
  });
});
