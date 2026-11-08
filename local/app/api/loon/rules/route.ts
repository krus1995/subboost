import { apiError } from "@local/lib/http";
import { isLoonRulePath, loadLoonRuleList } from "@local/lib/loon-rule-list";

export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("path");
  if (!path || !isLoonRulePath(path)) return apiError("未知的内置规则集", "NOT_FOUND", 404);
  try {
    return new Response(await loadLoonRuleList(path), {
      headers: { "content-type": "text/plain;charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  } catch {
    return apiError("规则集暂时不可用，请稍后重试。", "CONFIGURATION_ERROR", 503);
  }
}
