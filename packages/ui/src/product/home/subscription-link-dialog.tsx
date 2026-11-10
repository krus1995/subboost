"use client";

import * as React from "react";
import { SubscriptionLinkMenu } from "@subboost/ui/product/subscription/subscription-link-menu";
import { Link as LinkIcon, Loader2 } from "lucide-react";
import { Button } from "@subboost/ui/components/ui/button";
import { FormField } from "@subboost/ui/components/ui/form-field";
import { Input } from "@subboost/ui/components/ui/input";
import { Switch } from "@subboost/ui/components/ui/switch";
import { SwitchField } from "@subboost/ui/components/ui/switch-field";
import { SmartNodeMatchingHelp } from "@subboost/ui/components/subscription/smart-node-matching-help";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@subboost/ui/components/ui/dialog";
import {
  getAutoUpdateIntervalPolicyMinLabel,
  type AutoUpdateIntervalPolicy,
} from "@subboost/core/subscription/auto-update-interval";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscriptionUrl: string;
  subscriptionName: string;
  setSubscriptionName: (value: string) => void;
  autoUpdateEnabled: boolean;
  setAutoUpdateEnabled: (value: boolean) => void;
  autoUpdateHours: number;
  setAutoUpdateHours: (value: number) => void;
  autoUpdatePolicy: AutoUpdateIntervalPolicy;
  smartNodeMatchingEnabled: boolean;
  setSmartNodeMatchingEnabled: (value: boolean) => void;
  isCreatingSubscription: boolean;
  isEditingExistingSubscription: boolean;
  handleCreateSubscription: () => void;
  onLinkCopied: () => void;
};

export function SubscriptionLinkDialog({
  open,
  onOpenChange,
  subscriptionUrl,
  subscriptionName,
  setSubscriptionName,
  autoUpdateEnabled,
  setAutoUpdateEnabled,
  autoUpdateHours,
  setAutoUpdateHours,
  autoUpdatePolicy,
  smartNodeMatchingEnabled,
  setSmartNodeMatchingEnabled,
  isCreatingSubscription,
  isEditingExistingSubscription,
  handleCreateSubscription,
  onLinkCopied,
}: Props) {
  const close = () => onOpenChange(false);
  const minAutoUpdateLabel = getAutoUpdateIntervalPolicyMinLabel(autoUpdatePolicy);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinkIcon className="h-5 w-5 text-indigo-400" />
            {subscriptionUrl
              ? (isEditingExistingSubscription ? "订阅链接已更新" : "订阅链接已生成")
              : (isEditingExistingSubscription ? "更新订阅链接" : "生成订阅链接")}
          </DialogTitle>
          <DialogDescription>
            {subscriptionUrl
              ? "点击复制链接，选择 Clash 或 Loon 后导入客户端"
              : isEditingExistingSubscription
                ? "将覆盖该订阅的配置与订阅源，链接保持不变"
                : "生成持久化的订阅链接，支持在 Clash 客户端中自动更新"}
          </DialogDescription>
        </DialogHeader>

        {!subscriptionUrl && (
          <div className="space-y-4 py-4">
            <FormField label="订阅名称">
              <Input
                placeholder="例如：我的配置"
                value={subscriptionName}
                onChange={(e) => setSubscriptionName(e.target.value)}
                maxLength={100}
              />
            </FormField>

            <div className="rounded-lg border border-ink/10 bg-ink/5 p-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-fg-80">更新时智能匹配节点</p>
                    <SmartNodeMatchingHelp enabled={smartNodeMatchingEnabled} />
                  </div>
                </div>
                <Switch
                  checked={smartNodeMatchingEnabled}
                  onCheckedChange={setSmartNodeMatchingEnabled}
                  aria-label="更新时智能匹配节点"
                />
              </div>

              <div className="my-3 border-t border-ink/10" />

              <SwitchField
                label="启用自动更新"
                description="开启后服务器会按设定间隔刷新缓存"
                checked={autoUpdateEnabled}
                onCheckedChange={setAutoUpdateEnabled}
              />

              {autoUpdateEnabled && (
                <FormField
                  label="自动更新间隔（小时）"
                  description={`最小 ${minAutoUpdateLabel}，按创建时间计时`}
                  className="mt-4"
                >
                  <Input
                    type="number"
                    min={autoUpdatePolicy.minHours}
                    step={autoUpdatePolicy.stepHours}
                    value={autoUpdateHours}
                    onChange={(e) => setAutoUpdateHours(Number(e.target.value))}
                  />
                </FormField>
              )}
            </div>

            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm text-amber-200">
              <p className="font-medium mb-1">注意事项</p>
              <ul className="text-xs text-warning-muted-fg space-y-1">
                <li>🔒 配置数据将加密存储于服务器</li>
                <li>🔑 订阅链接相当于访问凭证，请勿公开分享</li>
                <li>⏱️ 客户端高频拉取订阅会被封禁，请合理配置</li>
                {isEditingExistingSubscription ? (
                  <>
                    <li>⚠️ 更新将覆盖原订阅配置与订阅源</li>
                    <li>✅ 订阅链接保持不变（无需在客户端重新导入）</li>
                  </>
                ) : (
                  <li>🗑️ 您可以随时在仪表盘删除订阅</li>
                )}
              </ul>
            </div>
          </div>
        )}

        <DialogFooter>
          {!subscriptionUrl ? (
            <>
              <Button variant="outline" onClick={close}>
                取消
              </Button>
              <Button
                onClick={handleCreateSubscription}
                disabled={!subscriptionName.trim() || isCreatingSubscription}
              >
                {isCreatingSubscription ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <LinkIcon className="h-4 w-4 mr-2" />
                )}
                {isEditingExistingSubscription ? "保存更新" : "生成链接"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={close}>完成</Button>
              <SubscriptionLinkMenu key={subscriptionUrl} url={subscriptionUrl} variant="default" onCopied={onLinkCopied} />
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
