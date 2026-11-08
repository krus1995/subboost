"use client";

import * as React from "react";
import { downloadLoonConfig } from "@subboost/ui/product/subscription/download-loon-config";
import { Button } from "@subboost/ui/components/ui/button";
import { loonImportUrl } from "./config-format";
import { localLoonConfigUrl, readLoonConfig } from "./loon-response";
import { LoonCompatibilityNotice } from "./loon-compatibility-notice";

type Check = { kind: "idle" } | { kind: "loading"; url: string } | { kind: "error"; url: string; message: string } | { kind: "ready"; url: string; config: string };

export function LoonSubscriptionActions({ url }: { url: string }) {
  const [check, setCheck] = React.useState<Check>({ kind: "idle" });
  const requestId = React.useRef(0);
  const pending = React.useRef(false);
  React.useEffect(() => () => { requestId.current += 1; }, []);
  const current = check.kind !== "idle" && check.url === url ? check : { kind: "idle" } as const;
  const prepare = async () => {
    if (pending.current) return;
    pending.current = true;
    const id = ++requestId.current;
    setCheck({ kind: "loading", url });
    try {
      const config = await readLoonConfig(await fetch(localLoonConfigUrl(url)));
      if (id === requestId.current) setCheck({ kind: "ready", url, config });
    } catch (error) {
      if (id === requestId.current) setCheck({ kind: "error", url, message: error instanceof Error ? error.message : "读取 Loon 配置失败" });
    } finally {
      if (id === requestId.current) pending.current = false;
    }
  };
  const download = () => {
    if (current.kind !== "ready") return;
    downloadLoonConfig(current.config);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {current.kind !== "ready" && <Button variant="outline" size="sm" onClick={() => void prepare()} disabled={current.kind === "loading"}>
        {current.kind === "loading" ? "正在检查 Loon 配置" : "检查 Loon 配置"}
      </Button>}
      {current.kind === "ready" && <>
        <Button asChild variant="outline" size="sm" title="打开 Loon"><a href={loonImportUrl(url)}>打开 Loon</a></Button>
        <Button variant="outline" size="sm" onClick={download}>下载 .conf</Button>
      </>}
      {current.kind === "error" && <>
        <p role="alert" className="w-full text-sm text-red-400">{current.message.split("\n# SUBBOOST-LOON-COMPAT v1 ")[0]}</p>
        <LoonCompatibilityNotice config={current.message} />
      </>}
      {current.kind === "ready" && <LoonCompatibilityNotice config={current.config} />}
    </div>
  );
}
