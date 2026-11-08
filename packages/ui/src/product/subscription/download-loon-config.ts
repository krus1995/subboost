export function downloadLoonConfig(config: string): void {
  const url = URL.createObjectURL(new Blob([config], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "loon.conf";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
