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
