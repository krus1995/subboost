"use client";

import * as React from "react";
import { generateLoonConfig } from "@subboost/core/generator/loon";
import { buildGenerateOptions } from "@subboost/ui/store/config-store/generated-yaml";
import { useConfigStore } from "@subboost/ui/store/config-store";
import { Button } from "@subboost/ui/components/ui/button";

type Generation =
  | { kind: "idle" }
  | { kind: "loading"; key: string }
  | { kind: "ready"; key: string; config: string }
  | { kind: "error"; key: string; message: string };

export async function loadLoonRuleList(path: string): Promise<string> {
  const response = await fetch(`/api/loon/rules?path=${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error(`读取 Loon 规则失败（${response.status}）`);
  return response.text();
}

export function LoonPreview() {
  const state = useConfigStore();
  const prepared = (() => {
    try { return { kind: "ready", options: buildGenerateOptions(state) } as const; }
    catch (error) { return { kind: "error", message: error instanceof Error ? error.message : "配置有错误" } as const; }
  })();
  const key = JSON.stringify(prepared);
  const [generation, setGeneration] = React.useState<Generation>({ kind: "idle" });
  const requestId = React.useRef(0);
  const pendingKey = React.useRef<string | null>(null);
  const ruleLists = React.useRef(new Map<string, Promise<string>>());
  const currentKey = React.useRef(key);
  currentKey.current = key;
  React.useEffect(() => () => { requestId.current += 1; }, []);
  const current = generation.kind !== "idle" && generation.key === key ? generation : { kind: "idle" } as const;

  const loadRuleList = (path: string): Promise<string> => {
    const existing = ruleLists.current.get(path);
    if (existing) return existing;
    const request = loadLoonRuleList(path).catch((error: unknown) => {
      ruleLists.current.delete(path);
      throw error;
    });
    ruleLists.current.set(path, request);
    return request;
  };

  const generate = async () => {
    if (prepared.kind !== "ready" || pendingKey.current === key || current.kind === "ready") return;
    pendingKey.current = key;
    const id = ++requestId.current;
    setGeneration({ kind: "loading", key });
    try {
      const config = await generateLoonConfig(prepared.options, loadRuleList);
      if (id === requestId.current && key === currentKey.current) setGeneration({ kind: "ready", key, config });
    } catch (error) {
      if (id === requestId.current && key === currentKey.current) {
        setGeneration({ kind: "error", key, message: error instanceof Error ? error.message : "生成 Loon 配置失败" });
      }
    } finally {
      if (id === requestId.current) pendingKey.current = null;
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
        <Button size="sm" onClick={() => void generate()} disabled={prepared.kind === "error" || current.kind === "loading" || current.kind === "ready"}>
          {current.kind === "loading" ? "正在生成 Loon 配置" : "生成 Loon 配置"}
        </Button>
        <Button size="sm" variant="outline" disabled={current.kind !== "ready"} onClick={download}>下载 .conf</Button>
      </div>
      {prepared.kind === "error" ? <p role="alert" className="text-sm text-red-400">{prepared.message}</p> : null}
      {current.kind === "error" ? <p role="alert" className="text-sm text-red-400">{current.message}</p> : null}
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre text-xs">{current.kind === "ready" ? current.config : "点击生成以预览 Loon 完整配置。配置在浏览器内生成。"}</pre>
    </div>
  );
}
