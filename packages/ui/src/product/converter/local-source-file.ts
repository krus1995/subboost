import { parseSubscription } from "@subboost/core/parser";
import { parseSourceRuleSnapshot } from "@subboost/core/subscription/source-rules";
import type { SubscriptionSource } from "@subboost/ui/store/config-store";
import { markSourceAsPendingImport } from "@subboost/ui/product/subscription/source-import-state";

type SourceFileStore = {
  sources: SubscriptionSource[];
  draftRevision?: number;
  setSources: (sources: SubscriptionSource[]) => void;
};

export function createLocalSourceFileReader(getState: () => SourceFileStore) {
  const requests = new Map<string, symbol>();
  return async (sourceId: string, file: Pick<File, "text">): Promise<"loaded" | "superseded"> => {
    const initial = getState();
    const source = initial.sources.find((item) => item.id === sourceId);
    if (!source || source.type !== "yaml") return "superseded";
    const request = Symbol();
    requests.set(sourceId, request);
    const isCurrent = () => requests.get(sourceId) === request
      && getState().draftRevision === initial.draftRevision
      && getState().sources.find((item) => item.id === sourceId) === source;
    try {
      const content = await file.text();
      if (!isCurrent()) return "superseded";
      if (parseSubscription(content).nodes.length === 0) throw new Error("文件中未找到可用节点，请选择 Clash YAML、节点链接或 Base64 订阅文件。");
      if (source.includeRules) parseSourceRuleSnapshot(content);
      const current = getState();
      current.setSources(current.sources.map((item) => item.id === sourceId ? markSourceAsPendingImport({
        ...item,
        content,
        readOnce: true,
        readOnceAttemptedUrls: undefined,
        useProxyProviders: undefined,
        userinfoUrl: undefined,
        userinfoUserAgent: undefined,
      }) : item));
      return "loaded";
    } catch (error) {
      if (!isCurrent()) return "superseded";
      throw error;
    } finally {
      if (requests.get(sourceId) === request) requests.delete(sourceId);
    }
  };
}