"use client";

import * as React from "react";
import { downloadLoonConfig } from "@subboost/ui/product/subscription/download-loon-config";
import { generateLoonConfig } from "@subboost/core/generator/loon";
import { buildGenerateOptions } from "@subboost/ui/store/config-store/generated-yaml";
import { useConfigStore } from "@subboost/ui/store/config-store";
import { Button } from "@subboost/ui/components/ui/button";
import { LoonCompatibilityNotice } from "@subboost/ui/product/subscription/loon-compatibility-notice";

type Generation =
  | { kind: "idle" }
  | { kind: "loading"; key: string }
  | { kind: "ready"; key: string; config: string; preview: string }
  | { kind: "error"; key: string; message: string };

export async function loadLoonRuleList(path: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`/api/loon/rules?path=${encodeURIComponent(path)}`, { signal });
  if (!response.ok) throw new Error(`读取 Loon 规则失败（${response.status}）`);
  return response.text();
}

export function summarizeLoonConfig(config: string): string {
  let end = -1;
  for (let line = 0; line < 200; line += 1) {
    end = config.indexOf("\n", end + 1);
    if (end < 0) return config;
  }
  return end < config.length - 1
    ? `${config.slice(0, end)}\n\n# 仅预览前 200 行，下载包含完整配置。`
    : config;
}

export function LoonPreview({ active = true }: { active?: boolean }) {
  const source = useConfigStore();
  const prepared = React.useMemo(() => {
    try {
      const options = buildGenerateOptions(source);
      return { kind: "ready", options, key: JSON.stringify(options) } as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成 Loon 配置失败";
      return { kind: "error", message, key: `error:${message}` } as const;
    }
  }, [source]);
  const [generation, setGeneration] = React.useState<Generation>({ kind: "idle" });
  const [retry, setRetry] = React.useState(0);
  const current = generation.kind !== "idle" && generation.key === prepared.key ? generation : { kind: "idle" } as const;
  const preparedRef = React.useRef(prepared);
  React.useEffect(() => { preparedRef.current = prepared; }, [prepared]);

  React.useEffect(() => {
    if (!active) return;
    const input = preparedRef.current;

    const controller = new AbortController();
    const pending = new Map<string, Promise<string>>();
    const load = (path: string): Promise<string> => {
      controller.signal.throwIfAborted();
      const existing = pending.get(path);
      if (existing) return existing;
      const request = loadLoonRuleList(path, controller.signal);
      pending.set(path, request);
      return request;
    };
    const timer = setTimeout(async () => {
      setGeneration({ kind: "loading", key: input.key });
      try {
        if (input.kind === "error") throw new Error(input.message);
        const config = await generateLoonConfig(input.options, load, { mode: "compatible" });
        if (controller.signal.aborted) return;
        const result = { kind: "ready", key: input.key, config, preview: summarizeLoonConfig(config) } as const;
        setGeneration(result);
      } catch (error) {
        if (!controller.signal.aborted) {
          const result = { kind: "error", key: input.key, message: error instanceof Error ? error.message : "生成 Loon 配置失败" } as const;
          setGeneration(result);
        }
      }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, prepared.key, retry]);

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={current.kind !== "ready"} onClick={() => { if (current.kind === "ready") downloadLoonConfig(current.config); }}>下载 .conf</Button>
        {current.kind === "error" && <Button size="sm" onClick={() => { setRetry((value) => value + 1); }}>重试</Button>}
      </div>
      {current.kind === "error" && <>
        <p role="alert" className="text-sm text-red-400">{current.message.split("\n# SUBBOOST-LOON-COMPAT v1 ")[0]}</p>
        <LoonCompatibilityNotice config={current.message} />
      </>}
      {current.kind === "ready" && <LoonCompatibilityNotice config={current.config} />}
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre text-xs">{current.kind === "ready" ? current.preview : current.kind === "error" ? "无法生成 Loon 配置。" : "正在生成 Loon 配置…"}</pre>
    </div>
  );
}
