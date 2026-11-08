import type { ParsedNode } from "../types/node";

function fail(): never {
  throw new Error("Loon 无法可靠表示此节点的协议、字段或参数，请检查节点配置");
}

function text(value: unknown, empty = false): string {
  if (typeof value !== "string" || (!empty && !value) || /[\u0000-\u001f\u007f-\u009f\u2028\u2029"\\]/u.test(value)) fail();
  return value;
}

export function validateLoonName(value: string): string {
  const name = text(value);
  if (name.trim() !== name || /[,=\[\]#;]/u.test(name)) fail();
  return name;
}

function quoted(value: unknown, empty = false): string {
  return `"${text(value, empty)}"`;
}

function token(value: unknown): string {
  const result = text(value);
  if (/[\s,=\[\]#;]/u.test(result)) fail();
  return result;
}

const ssCiphers = new Set("2022-blake3-aes-128-gcm 2022-blake3-aes-256-gcm aes-128-gcm aes-192-gcm aes-256-gcm chacha20-ietf-poly1305 xchacha20-ietf-poly1305 rc4 rc4-md5 aes-128-cfb aes-192-cfb aes-256-cfb aes-128-ctr aes-192-ctr aes-256-ctr bf-cfb camellia-128-cfb camellia-192-cfb camellia-256-cfb cast5-cfb des-cfb idea-cfb rc2-cfb seed-cfb salsa20 chacha20 chacha20-ietf".split(" "));
const vmessCiphers = new Set(["none", "auto", "aes-128-cfb", "aes-128-gcm", "chacha20-ietf-poly1305"]);

/** Serialize only options whose semantics are documented by Loon. */
export function renderLoonNode(node: ParsedNode): string {
  const data: Record<string, unknown> = node;
  const consumed = new Set(["name", "type", "server", "port", "_originName", "_sourceIds", "_meta"]);
  const take = (key: string): unknown => { consumed.add(key); return data[key]; };
  const name = validateLoonName(node.name);
  const server = token(node.server);
  if (!Number.isInteger(node.port) || Number(node.port) < 1 || Number(node.port) > 65535) fail();
  const parts = [server, String(node.port)];
  const option = (key: string, value: string) => parts.push(`${key}=${value}`);
  const boolean = (key: string, output = key) => {
    const value = take(key);
    if (value !== undefined) {
      if (typeof value !== "boolean") fail();
      option(output, String(value));
    }
  };
  let protocol: string;
  let tls = false;
  switch (node.type) {
    case "ss": {
      protocol = "Shadowsocks";
      const cipher = token(take("cipher"));
      if (!ssCiphers.has(cipher)) fail();
      parts.push(cipher, quoted(take("password")));
      boolean("udp-over-tcp");
      break;
    }
    case "vmess":
    case "vless":
    case "trojan": {
      protocol = node.type === "vmess" ? "VMess" : node.type === "vless" ? "VLESS" : "Trojan";
      if (node.type === "vmess") {
        const cipher = token(take("cipher"));
        if (!vmessCiphers.has(cipher)) fail();
        parts.push(cipher);
      }
      if (node.type === "trojan") parts.push(quoted(take("password")));
      else {
        const uuid = text(take("uuid"));
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) fail();
        parts.push(quoted(uuid));
      }
      const network = take("network") ?? "tcp";
      if (network !== "tcp" && network !== "ws") fail();
      option("transport", network);
      if (node.type === "vmess") {
        const alterId = take("alterId");
        if (typeof alterId !== "number" || !Number.isInteger(alterId) || alterId < 0 || alterId > 65535) fail();
        option("alterId", String(alterId));
      }
      if (node.type === "vless") {
        const encryption = take("encryption");
        if (encryption !== undefined && encryption !== "none") fail();
      }
      if (network === "ws") {
        const ws = take("ws-opts");
        if (ws !== undefined) {
          if (!ws || typeof ws !== "object" || Array.isArray(ws)) fail();
          for (const [key, value] of Object.entries(ws)) {
            if (value === undefined) continue;
            if (key === "path") option("path", quoted(value));
            else if (key === "headers") {
              if (!value || typeof value !== "object" || Array.isArray(value)) fail();
              const headers = Object.entries(value);
              if (headers.length > 1) fail();
              for (const [header, host] of headers) {
                if (header.toLowerCase() !== "host") fail();
                option("host", quoted(host));
              }
            } else fail();
          }
        }
      }
      const tlsValue = take("tls");
      if (tlsValue !== undefined && typeof tlsValue !== "boolean") fail();
      if (node.type === "trojan" && tlsValue === false) fail();
      tls = node.type === "trojan" || tlsValue === true;
      if (node.type !== "trojan") option("over-tls", String(tls));
      const flow = take("flow");
      if (flow !== undefined && flow !== "") {
        if (node.type !== "vless" || network !== "tcp" || !tls || flow !== "xtls-rprx-vision") fail();
        option("flow", flow);
      }
      const reality = take("reality-opts");
      if (reality !== undefined) {
        if (!tls || network !== "tcp" || !reality || typeof reality !== "object" || Array.isArray(reality)) fail();
        const entries = Object.entries(reality);
        const publicKey = entries.find(([key]) => key === "public-key")?.[1];
        const shortId = entries.find(([key]) => key === "short-id")?.[1];
        if (typeof publicKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(publicKey)) fail();
        if (shortId !== undefined && (typeof shortId !== "string" || !/^(?:[a-fA-F0-9]{2}){0,8}$/.test(shortId))) fail();
        if (entries.some(([key]) => key !== "public-key" && key !== "short-id")) fail();
        if (!data.servername && !data.sni) fail();
        option("public-key", quoted(publicKey));
        if (shortId !== undefined) option("short-id", quoted(shortId, true));
      }
      break;
    }
    case "hysteria2": {
      protocol = "Hysteria2";
      parts.push(quoted(take("password")));
      tls = true;
      break;
    }
    case "http":
    case "https":
    case "socks5": {
      const tlsValue = take("tls");
      if (tlsValue !== undefined && typeof tlsValue !== "boolean") fail();
      if (node.type === "https" && tlsValue === false) fail();
      tls = node.type === "https" || tlsValue === true;
      protocol = node.type === "socks5" ? "socks5" : tls ? "https" : "http";
      const username = take("username");
      const password = take("password");
      if (username !== undefined || password !== undefined) {
        if (username === undefined || password === undefined) fail();
        parts.push(quoted(username, true), quoted(password, true));
      }
      if (node.type === "socks5") option("over-tls", String(tls));
      break;
    }
    default: fail();
  }
  boolean("udp");
  boolean("tfo", "fast-open");
  if (tls) {
    boolean("skip-cert-verify");
    const fingerprint = take("client-fingerprint");
    if (fingerprint !== undefined) {
      if (node.type === "hysteria2" || !["chrome", "chrome147", "safari-ios18", "safari-ios-26"].includes(text(fingerprint))) fail();
      option("tls-profile", token(fingerprint));
    }
    const sni = take("sni");
    const servername = take("servername");
    if (sni !== undefined && servername !== undefined && sni !== servername) fail();
    if (sni !== undefined || servername !== undefined) option("sni", token(sni ?? servername));
    const alpn = take("alpn");
    if (alpn !== undefined) {
      if ((node.type !== "trojan" && node.type !== "hysteria2") || !Array.isArray(alpn) || !alpn.length) fail();
      option("alpn", quoted(alpn.map(token).join(",")));
    }
  }
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && !consumed.has(key)) fail();
  }
  return `${name} = ${protocol},${parts.join(",")}`;
}


