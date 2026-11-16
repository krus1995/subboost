"use client";

import * as React from "react";
import { Input } from "@subboost/ui/components/ui/input";
import { toast } from "@subboost/ui/components/ui/toaster";
import type { createLocalSourceFileReader } from "./local-source-file";

export type LoadSourceFile = ReturnType<typeof createLocalSourceFileReader>;

export function LocalSourceFileInput({ sourceId, onLoadFile }: {
  sourceId: string;
  onLoadFile: LoadSourceFile;
}) {
  const inputId = React.useId();
  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="text-xs text-fg-60">本地上传</label>
      <Input
        id={inputId}
        type="file"
        accept=".yaml,.yml,.txt,.conf,text/yaml,application/yaml,text/plain"
        aria-label="本地上传订阅文件"
        className="h-auto text-xs file:mr-2 file:text-xs"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          void onLoadFile(sourceId, file).then((result) => {
            if (result === "loaded") toast({ title: "文件已读取，请点击「导入此源」或在高级编辑中点「完成」。" });
          }).catch(() => {
            toast({ title: "读取失败，请选择含可用节点的订阅文件；使用来源规则时需提供完整 Clash YAML。原来源已保留。", variant: "destructive" });
          });
        }}
      />
      <p className="text-[11px] text-fg-40">支持 YAML、节点链接和 Base64 文本。上传后保存快照，不自动更新；可重新选文件替换，也可在高级编辑中使用文件内的策略组和规则。</p>
    </div>
  );
}