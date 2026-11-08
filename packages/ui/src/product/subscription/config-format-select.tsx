"use client";

import type { ConfigFormat } from "./config-format";

export function ConfigFormatSelect({ value, onChange }: { value: ConfigFormat; onChange: (format: ConfigFormat) => void }) {
  return (
    <select aria-label="配置格式" className="h-8 rounded-md border border-ink/20 bg-surface px-2 text-sm" value={value}
      onChange={(event) => { if (event.target.value === "clash" || event.target.value === "loon") onChange(event.target.value); }}>
      <option value="clash">Clash</option>
      <option value="loon">Loon</option>
    </select>
  );
}
