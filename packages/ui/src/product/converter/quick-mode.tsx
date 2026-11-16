"use client";

import { SourceRulesEditor } from "./source-rules-editor";
import { SourcesSection } from "./quick-mode/sources-section";
import { TemplatesSection } from "./quick-mode/templates-section";

export function QuickMode() {
  return (
    <div className="flex flex-col gap-3">
      <SourcesSection />
      <SourceRulesEditor />
      <TemplatesSection />
    </div>
  );
}
