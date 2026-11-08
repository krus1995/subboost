import { readLoonCompatibility } from "./loon-response";

function skipReason(reason: string) {
  switch (reason) {
    case "unsupported-protocol": return "Loon 不支持此协议";
    case "unsupported-transport": return "Loon 不支持此传输方式";
    case "unsupported-http-upgrade": return "Loon 不支持 HTTP Upgrade";
    case "unsupported-client-fingerprint": return "Loon 不支持此客户端指纹";
    default: return "当前参数无法转换";
  }
}

export function LoonCompatibilityNotice({ config }: { config: string }) {
  const report = readLoonCompatibility(config);
  if (!report || report.skipped === 0) return null;
  return (
    <div role="status" className="w-full text-sm text-amber-500">
      <p>可导出 {report.included} 个节点，跳过 {report.skipped} 个不兼容节点。</p>
      {report.skippedGroups > 0 && <p>移除 {report.skippedGroups} 个没有兼容出站的策略组。</p>}
      <details>
        <summary>查看跳过详情</summary>
        <ul>
          {report.nodes.map((node) => <li key={node.index}>第 {node.index} 个节点：{skipReason(node.reason)}（{node.protocol} / {node.transport}）。</li>)}
          {report.groups.map((index) => <li key={`group-${index}`}>第 {index} 个策略组因没有兼容出站而移除。</li>)}
        </ul>
      </details>
    </div>
  );
}
