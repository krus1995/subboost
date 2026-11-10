"use client";

import * as React from "react";
import { isCleanNewSubscriptionIntent } from "@subboost/ui/product/subscription/home-url-intent";
import { useConfigStore } from "@subboost/ui/store/config-store";

type Options = {
  authChecked: boolean;
  searchParams: Pick<URLSearchParams, "get">;
  setEditingSubscription: (subscription: null) => void;
  setSubscriptionName: (name: string) => void;
  setSubscriptionUrl: (url: string) => void;
};

export function useCleanNewSubscriptionIntent({
  authChecked,
  searchParams,
  setEditingSubscription,
  setSubscriptionName,
  setSubscriptionUrl,
}: Options) {
  const shouldStartCleanNewSubscription = isCleanNewSubscriptionIntent(searchParams);
  const handledNewSubscriptionIntentRef = React.useRef(false);

  React.useEffect(() => {
    if (!shouldStartCleanNewSubscription) {
      handledNewSubscriptionIntentRef.current = false;
      return;
    }
    if (!authChecked || handledNewSubscriptionIntentRef.current) return;

    handledNewSubscriptionIntentRef.current = true;
    useConfigStore.getState().reset();
    useConfigStore.getState().generateConfig();
    setEditingSubscription(null);
    setSubscriptionName("");
    setSubscriptionUrl("");
  }, [
    authChecked,
    setEditingSubscription,
    setSubscriptionName,
    setSubscriptionUrl,
    shouldStartCleanNewSubscription,
  ]);
}
