export async function readLoonConfig(response: Response): Promise<string> {
  const text = await response.text();
  if (!response.ok) {
    let message = `读取 Loon 配置失败（${response.status}）`;
    try {
      const data: unknown = JSON.parse(text);
      if (data && typeof data === "object" && "error" in data && typeof data.error === "string") message = data.error;
    } catch {}
    throw new Error(message);
  }
  if (response.headers.get("content-type")?.includes("text/html") || !/^\[General\]\s*$/m.test(text) || !/^\[Rule\]\s*$/m.test(text)) {
    throw new Error("服务器未返回有效的 Loon 配置，请检查订阅地址或登录状态");
  }
  return text;
}

export function localLoonConfigUrl(url: string): string {
  const parsed = new URL(url, globalThis.location?.href ?? "http://localhost");
  return `${parsed.pathname}${parsed.search}`;
}

export function readLoonCompatibility(config: string) {
  const summary = /^# SUBBOOST-LOON-COMPAT v1 included=(\d+) skipped=(\d+)$/m.exec(config);
  if (!summary) return null;
  const nodes = Array.from(config.matchAll(/^# SUBBOOST-LOON-SKIP v1 index=(\d+) protocol=(ss|vmess|vless|trojan|hysteria2|http|https|socks5|ssr|anytls|hysteria|tuic|wireguard|snell|socks4|ssh|direct|reject|dns|mieru|masque|sudoku|trusttunnel|relay|unknown) transport=(tcp|raw|ws|http|h2|grpc|xhttp|httpupgrade|quic|kcp|none|unknown) reason=(unsupported-protocol|unsupported-transport|unsupported-http-upgrade|unsupported-client-fingerprint|unsupported-settings)$/gm), (match) => ({
    index: Number(match[1]), protocol: match[2], transport: match[3], reason: match[4],
  }));
  const groupSummary = /^# SUBBOOST-LOON-GROUPS v1 skipped=(\d+)$/m.exec(config);
  const groups = Array.from(config.matchAll(/^# SUBBOOST-LOON-GROUP-SKIP v1 index=(\d+) reason=no-compatible-outbound$/gm), (match) => Number(match[1]));
  return { included: Number(summary[1]), skipped: Number(summary[2]), nodes, skippedGroups: Number(groupSummary?.[1] ?? 0), groups };
}
