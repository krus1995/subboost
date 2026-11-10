"use client";

import * as React from "react";
import { Copy } from "lucide-react";
import { Button } from "@subboost/ui/components/ui/button";
import { Input } from "@subboost/ui/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@subboost/ui/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@subboost/ui/components/ui/dropdown-menu";
import { toast } from "@subboost/ui/components/ui/toaster";
import { copyTextToClipboard } from "@subboost/ui/lib/clipboard";
import { SubscriptionQrCode } from "./subscription-qr-code";
import { subscriptionFormats, subscriptionFormatUrl, loonImportUrl, type ConfigFormat } from "./config-format";
import { downloadLoonConfig } from "./download-loon-config";
import { localLoonConfigUrl, readLoonConfig } from "./loon-response";

const formats = Object.values(subscriptionFormats);
type LinkDialog = { kind: "closed" } | { kind: "more" | "manual"; format: ConfigFormat; url: string };

type Props = {
  url: string;
  onDownloadClash?: () => void;
  onCopied?: () => void;
  context?: "dashboard" | "dialog";
};

export function SubscriptionLinkMenu({ url, onDownloadClash, onCopied, context = "dashboard" }: Props) {
  const isDashboard = context === "dashboard";
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = React.useState<LinkDialog>({ kind: "closed" });
  const currentDialog = dialog.kind !== "closed" && subscriptionFormatUrl(url, dialog.format) === dialog.url ? dialog : { kind: "closed" } as const;
  const latestUrl = React.useRef<string | null>(url);
  React.useEffect(() => {
    latestUrl.current = url;
    return () => { latestUrl.current = null; };
  }, [url]);
  const downloading = React.useRef(false);

  const copy = async (format: ConfigFormat) => {
    const selectedUrl = subscriptionFormatUrl(url, format);
    const success = await copyTextToClipboard(selectedUrl);
    if (latestUrl.current !== url) return;
    if (success) {
      onCopied?.();
      toast({ title: `已复制 ${subscriptionFormats[format].label} 订阅链接` });
    } else {
      setDialog({ kind: "manual", format, url: selectedUrl });
    }
  };

  const download = async () => {
    if (downloading.current) return;
    downloading.current = true;
    try {
      const config = await readLoonConfig(await fetch(localLoonConfigUrl(subscriptionFormatUrl(url, "loon"))));
      if (latestUrl.current === url) downloadLoonConfig(config);
    } catch (error) {
      if (latestUrl.current === url) toast({ title: "下载失败", description: error instanceof Error ? error.message.split("\n# SUBBOOST-LOON-COMPAT v1 ")[0] : "请稍后重试", variant: "destructive" });
    } finally {
      downloading.current = false;
    }
  };

  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          variant={isDashboard ? "ghost" : "default"}
          size={isDashboard ? "sm" : "default"}
          className={isDashboard ? "gap-0 px-2 sm:gap-2 sm:px-3" : undefined}
          title="复制订阅链接"
          aria-label="复制链接"
          disabled={!url}
        >
          <Copy className="h-4 w-4" />
          <span className={isDashboard ? "hidden sm:inline" : undefined}>复制链接</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36 border-ink/10 bg-surface-raised text-fg">
        {formats.map((format) => <DropdownMenuItem key={format.value} className="focus:bg-ink/5 focus:text-fg" onSelect={() => void copy(format.value)}>{format.label}</DropdownMenuItem>)}
        <DropdownMenuSeparator className="bg-ink/10" />
        <DropdownMenuItem className="focus:bg-ink/5 focus:text-fg" onSelect={() => setDialog({ kind: "more", format: "clash", url })}>更多方式</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={currentDialog.kind !== "closed"} onOpenChange={(open) => { if (!open) setDialog({ kind: "closed" }); }}>
      <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus(); }} className="w-[calc(100vw-2rem)] sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{currentDialog.kind === "closed" ? "订阅链接" : `${subscriptionFormats[currentDialog.format].label} ${currentDialog.kind === "more" ? "订阅导入" : "订阅链接"}`}</DialogTitle>
          <DialogDescription>{currentDialog.kind === "manual" ? "自动复制失败，请选中下方链接手动复制。" : "选择客户端，扫码导入或复制下方链接。"}</DialogDescription>
        </DialogHeader>
        {currentDialog.kind !== "closed" && <>
          {currentDialog.kind === "more" && <>
            <div className="flex gap-2" role="group" aria-label="客户端格式">
              {formats.map((format) => <Button key={format.value} variant={currentDialog.format === format.value ? "default" : "outline"} size="sm" aria-pressed={currentDialog.format === format.value} onClick={() => setDialog({ kind: "more", format: format.value, url: subscriptionFormatUrl(url, format.value) })}>{format.label}</Button>)}
            </div>
            <SubscriptionQrCode url={currentDialog.url} />
            <div className="flex gap-2">
              {currentDialog.format === "loon" && <>
                <Button asChild variant="outline" size="sm"><a href={loonImportUrl(currentDialog.url)}>打开 Loon</a></Button>
                <Button variant="outline" size="sm" onClick={() => void download()}>下载 .conf</Button>
              </>}
              {currentDialog.format === "clash" && (onDownloadClash ? <Button variant="outline" size="sm" onClick={onDownloadClash}>下载 .yaml</Button> : <Button asChild variant="outline" size="sm"><a href={currentDialog.url} download="config.yaml">下载 .yaml</a></Button>)}
            </div>
          </>}
          <Input aria-label="订阅链接" value={currentDialog.url} readOnly className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
        </>}
      </DialogContent>
    </Dialog>
  </>;
}
