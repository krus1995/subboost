"use client";

import * as React from "react";
import { generateLoonConfig } from "@subboost/core/generator/loon";
import { buildGenerateOptions } from "@subboost/ui/store/config-store/generated-yaml";
import { useConfigStore } from "@subboost/ui/store/config-store";
import { Button } from "@subboost/ui/components/ui/button";

type Source = ReturnType<typeof useConfigStore.getState>;
type Generation =
  | { kind: "idle" }
  | { kind: "loading"; source: Source }
  | { kind: "ready"; source: Source; config: string; preview: string }
  | { kind: "error"; source: Source; message: string };

export async function loadLoonRuleList(path: string): Promise<string> {
  const response = await fetch(`/api/loon/rules?path=${encodeURIComponent(path)}`);
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
export function LoonPreview() {
  const source = useConfigStore();
  const [generation, setGeneration] = React.useState<Generation>({ kind: "idle" });
  const requestId = React.useRef(0);
  const pendingSource = React.useRef<Source | null>(null);
  const ruleLists = React.useRef(new Map<string, Promise<string>>());
  React.useEffect(() => () => { requestId.current += 1; }, []);
  const current = generation.kind !== "idle" && generation.source === source ? generation : { kind: "idle" } as const;

  const loadRuleList = (path: string): Promise<string> => {
    const existing = ruleLists.current.get(path);
    if (existing) return existing;
    const request = loadLoonRuleList(path).finally(() => { ruleLists.current.delete(path); });
    ruleLists.current.set(path, request);
    return request;
  };

  const generate = async () => {
    if (pendingSource.current === source || current.kind === "ready") return;
    pendingSource.current = source;
    const id = ++requestId.current;
    setGeneration({ kind: "loading", source });
    try {
      const config = await generateLoonConfig(buildGenerateOptions(source), loadRuleList);
      if (id === requestId.current && source === useConfigStore.getState()) setGeneration({ kind: "ready", source, config, preview: summarizeLoonConfig(config) });
    } catch (error) {
      if (id === requestId.current && source === useConfigStore.getState()) {
        setGeneration({ kind: "error", source, message: error instanceof Error ? error.message : "生成 Loon 配置失败" });
      }
    } finally {
      if (id === requestId.current) pendingSource.current = null;
    }
  };

  const download = () => {
    if (current.kind !== "ready") return;
    const url = URL.createObjectURL(new Blob([current.config], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "loon.conf";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void generate()} disabled={current.kind === "loading" || current.kind === "ready"}>
          {current.kind === "loading" ? "正在生成 Loon 配置" : "生成 Loon 配置"}
        </Button>
        <Button size="sm" variant="outline" disabled={current.kind !== "ready"} onClick={download}>下载 .conf</Button>
      </div>
      {current.kind === "error" ? <p role="alert" className="text-sm text-red-400">{current.message}</p> : null}
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre text-xs">{current.kind === "ready" ? current.preview : "点击生成以预览 Loon 完整配置。"}</pre>
    </div>
  );
}
