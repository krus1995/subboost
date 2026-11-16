/**
 * Airport subscriptions often encode account metadata as proxy nodes. They
 * should remain visible in the main selection list, but must not be treated as
 * usable proxies for url-test, fallback, or routing policy groups.
 */
const SUBSCRIPTION_INFO_NODE_NAME_RE =
  /^(当前流量|剩余流量|剩余订阅流量|距离下次重置剩余|套餐到期|订阅到期|到期时间|过期时间)\s*[:：]/;
const PIPE_STYLE_ACCOUNT_INFO_NODE_NAME_RE = /^(余额|会员)\s*\|/;
const SUBSCRIPTION_UPDATE_HINT_NODE_NAME_RE = /(版本太旧|请更新|更新软件|去官网更新)/;

export function isSubscriptionInfoNodeName(name: string): boolean {
  const trimmed = name.trim();
  return (
    SUBSCRIPTION_INFO_NODE_NAME_RE.test(trimmed) ||
    PIPE_STYLE_ACCOUNT_INFO_NODE_NAME_RE.test(trimmed) ||
    SUBSCRIPTION_UPDATE_HINT_NODE_NAME_RE.test(trimmed)
  );
}
