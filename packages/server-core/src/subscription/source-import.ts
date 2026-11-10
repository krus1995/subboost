import { parseSubscription } from "@subboost/core/parser";
import {
  hasClientUpdatePlaceholderError,
  looksLikeClientUpdatePlaceholderNodes,
} from "@subboost/core/parser/placeholder";
import {
  createSubscriptionImportErrorInfo,
  inferSubscriptionImportErrorCategory,
  sanitizePublicErrorText,
  type SubscriptionImportErrorInfo,
} from "@subboost/core/subscription/import-error";
import { tryNormalizeSubscriptionUrlInput } from "@subboost/core/subscription/url-input";
import type { ParseResult, ParsedNode } from "@subboost/core/types/node";
import { createSubscriptionRequestBudget, hasUsableSubscriptionSnapshot,
  type SubscriptionSnapshotComparison } from "./snapshot-comparison";
import { SUBSCRIPTION_IMPORT_USER_AGENTS } from "./user-agents";

export type SourceImportPurpose = "content" | "userinfo";

export type SourceImportTransportRequest = {
  url: string;
  userAgent: string;
  purpose: SourceImportPurpose;
  timeoutMs: number;
  maxBytes: number;
};

export type SourceImportTransportResult = {
  ok: boolean;
  content?: string;
  headers?: Record<string, string>;
  error?: string;
  errorInfo?: SubscriptionImportErrorInfo | null;
  responseStatus?: number;
  publicReason?: string | null;
};

export type SourceImportRequest = {
  url: string;
  userinfoUrl?: string;
  userinfoUserAgent?: string;
};

export type SourceImportSuccess = {
  ok: true;
  content: string;
  headers: Record<string, string>;
  parsedNodes: ParsedNode[];
  parseErrors: string[];
  diagnostics?: SubscriptionSnapshotComparison[];
};

export type SourceImportFailure = {
  ok: false;
  error: string;
  errorInfo: SubscriptionImportErrorInfo;
  responseStatus?: number;
  publicReason?: string | null;
};

export type SourceImportResult = SourceImportSuccess | SourceImportFailure;

export function buildSourceImportParseResult(
  result: Pick<SourceImportSuccess, "parsedNodes" | "parseErrors">
): ParseResult {
  const nodes = result.parsedNodes;
  const errors = result.parseErrors;
  return {
    nodes,
    errors,
    totalParsed: nodes.length,
    totalFailed: errors.length,
  };
}

type ParsedAttempt =
  | {
      ok: true;
      userAgent: string;
      content: string;
      headers: Record<string, string>;
      parsed: ParseResult;
    }
  | {
      ok: false;
      userAgent: string;
      error: string;
      errorInfo?: SubscriptionImportErrorInfo | null;
      responseStatus?: number;
      publicReason?: string | null;
    };

function createErrorInfo(message: string, httpStatus?: number): SubscriptionImportErrorInfo {
  return createSubscriptionImportErrorInfo({
    category: inferSubscriptionImportErrorCategory(message),
    message,
    detail: message,
    httpStatus,
  });
}

function isUsableParsedAttempt(attempt: ParsedAttempt): attempt is Extract<ParsedAttempt, { ok: true }> {
  return attempt.ok && hasUsableSubscriptionSnapshot(attempt.parsed);
}

function toFailure(attempt: ParsedAttempt | null, fallback = "获取 url 失败"): SourceImportFailure {
  if (!attempt) {
    return {
      ok: false,
      error: fallback,
      errorInfo: createErrorInfo(fallback),
    };
  }

  if (!attempt.ok) {
    const message = sanitizePublicErrorText(attempt.error) || fallback;
    return {
      ok: false,
      error: message,
      errorInfo: attempt.errorInfo ?? createErrorInfo(message, attempt.responseStatus),
      responseStatus: attempt.responseStatus,
      publicReason: attempt.publicReason ?? null,
    };
  }

  const parseError = attempt.parsed.errors[0] || "未解析到有效节点";
  const message = hasClientUpdatePlaceholderError(attempt.parsed.errors) ||
    looksLikeClientUpdatePlaceholderNodes(attempt.parsed.nodes)
    ? "订阅服务返回了客户端更新提示占位内容，未导入该结果"
    : parseError;
  return {
    ok: false,
    error: message,
    errorInfo: createSubscriptionImportErrorInfo({
      category: "parse",
      message,
      detail: parseError,
    }),
  };
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const normalizedKey = key.toLowerCase().trim();
    if (!normalizedKey || typeof value !== "string") continue;
    out[normalizedKey] = value;
  }
  return out;
}

async function fetchAndParseWithUserAgent(
  url: string,
  userAgent: string,
  options: {
    timeoutMs: number;
    maxBytes: number;
    fetchText: (request: SourceImportTransportRequest) => Promise<SourceImportTransportResult>;
  }
): Promise<ParsedAttempt> {
  let response: SourceImportTransportResult;
  try {
    response = await options.fetchText({
      url,
      userAgent,
      purpose: "content",
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
    });
  } catch {
    response = { ok: false, error: "订阅请求失败" };
  }
  if (!response.ok || typeof response.content !== "string") {
    const message = sanitizePublicErrorText(response.error) || "获取 url 失败";
    return {
      ok: false,
      userAgent,
      error: message,
      errorInfo: response.errorInfo,
      responseStatus: response.responseStatus,
      publicReason: response.publicReason ?? null,
    };
  }

  return {
    ok: true,
    userAgent,
    content: response.content,
    headers: normalizeHeaders(response.headers),
    parsed: parseSubscription(response.content),
  };
}

async function fetchSupplementalUserInfoHeaders(
  request: SourceImportRequest,
  options: {
    timeoutMs: number;
    maxBytes: number;
    fetchText: (request: SourceImportTransportRequest) => Promise<SourceImportTransportResult>;
  },
  fallbackUrl: string
): Promise<Record<string, string>> {
  if (!request.userinfoUrl) return {};
  const rawUrl = request.userinfoUrl || fallbackUrl;
  const url = tryNormalizeSubscriptionUrlInput(rawUrl);
  if (!url) return {};
  const contentUrl = new URL(fallbackUrl);
  const metadataUrl = new URL(url);
  contentUrl.hash = "";
  metadataUrl.hash = "";
  if (contentUrl.href === metadataUrl.href) return {};
  const response = await options.fetchText({
    url,
    userAgent: request.userinfoUserAgent?.trim() || SUBSCRIPTION_IMPORT_USER_AGENTS[0],
    purpose: "userinfo",
    timeoutMs: Math.min(options.timeoutMs, 8000),
    maxBytes: options.maxBytes,
  });
  return response.ok ? normalizeHeaders(response.headers) : {};
}

export async function importSubscriptionFromUrl(
  request: SourceImportRequest,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    userAgents?: readonly string[];
    fetchText: (request: SourceImportTransportRequest) => Promise<SourceImportTransportResult>;
  }
): Promise<SourceImportResult> {
  const url = tryNormalizeSubscriptionUrlInput(request.url);
  if (!url) {
    return {
      ok: false,
      error: "无效的 url 格式",
      errorInfo: createSubscriptionImportErrorInfo({
        category: "format",
        message: "无效的 url 格式",
      }),
    };
  }
  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return {
      ok: false,
      error: "只支持 HTTP/HTTPS url",
      errorInfo: createSubscriptionImportErrorInfo({
        category: "format",
        message: "只支持 HTTP/HTTPS url",
      }),
    };
  }

  const timeoutMs = options.timeoutMs ?? 15000;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const userAgent = options.userAgents?.[0] || SUBSCRIPTION_IMPORT_USER_AGENTS[0];
  const budget = createSubscriptionRequestBudget(timeoutMs);
  const remainingTimeout = budget.remainingTimeout();
  if (remainingTimeout === 0) return toFailure(null);
  const best = await fetchAndParseWithUserAgent(url, userAgent, {
    timeoutMs: remainingTimeout, maxBytes, fetchText: options.fetchText,
  });

  if (!best || !best.ok || !isUsableParsedAttempt(best)) {
    return toFailure(best);
  }

  const supplementalHeaders = budget.remainingTimeout() === 0 ? {} : await fetchSupplementalUserInfoHeaders(request, {
    timeoutMs: budget.remainingTimeout(),
    maxBytes,
    fetchText: options.fetchText,
  }, url).catch(() => ({}));

  return {
    ok: true,
    content: best.content,
    headers: { ...best.headers, ...supplementalHeaders },
    parsedNodes: best.parsed.nodes,
    parseErrors: best.parsed.errors,
    diagnostics: [],
  };
}
