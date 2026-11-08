import { describe, expect, it } from "vitest";
import type { ParsedNode } from "../types/node";
import { parseVLESS } from "../parser/protocols/vless";
import { parseSS } from "../parser/protocols/ss";
import { parseConfigLine } from "../parser/config-line-parser";
import { renderLoonNode, validateLoonName } from "./loon-node";

const base = { name: "香港 🇭🇰", server: "example.com", port: 443 };
const uuid = "52396e06-041a-4cc2-be5c-8525eb457809";
const ss: ParsedNode = { ...base, type: "ss", cipher: "aes-128-gcm", password: "pass,word" };

describe("Loon native nodes", () => {
  it.each<ParsedNode>([
    ss,
    { ...base, type: "vmess", uuid, cipher: "auto" },
    { ...base, type: "vless", uuid },
    { ...base, type: "trojan", password: "secret" },
    { ...base, type: "hysteria2", password: "secret" },
    { ...base, type: "socks5" },
  ])("preserves default UDP and QUIC forwarding for $type", (node) => {
    expect(renderLoonNode(node)).toContain("udp=true,block-quic=false");
    expect(renderLoonNode({ ...node, udp: true })).toContain("udp=true,block-quic=false");
    const disabled = renderLoonNode({ ...node, udp: false });
    expect(disabled).toContain("udp=false");
    expect(disabled).not.toContain("block-quic");
  });
  it("quotes comma credentials and preserves Unicode and internal source metadata", () => {
    expect(renderLoonNode({ ...ss, _originName: "original", _sourceIds: ["source"], _meta: {} }))
      .toBe('香港 🇭🇰 = Shadowsocks,example.com,443,aes-128-gcm,"pass,word",udp=true,block-quic=false');
  });
  it("uses native protocol syntax and the existing parser can read it", () => {
    const node: ParsedNode = { ...base, type: "vmess", uuid, alterId: 0, cipher: "auto", tls: true, servername: "tls.example.com", "skip-cert-verify": false, network: "ws", "ws-opts": { path: "/socket", headers: { Host: "cdn.example.com" } } };
    const line = renderLoonNode(node);
    expect(line).toContain('VMess,example.com,443,auto,"52396e06-041a-4cc2-be5c-8525eb457809",transport=ws,alterId=0,path="/socket",host="cdn.example.com",over-tls=true');
    expect(parseConfigLine(line)).toMatchObject({ type: "vmess", uuid, tls: true, "skip-cert-verify": false, network: "ws" });
  });
  it("converts actual URI parser output", () => {
    expect(renderLoonNode(parseSS("ss://YWVzLTEyOC1nY206c2VjcmV0@example.com:443#SS"))).toContain('Shadowsocks,example.com,443,aes-128-gcm,"secret"');
    const node = parseVLESS(`vless://${uuid}@example.com:443?security=tls&type=ws&host=cdn.example.com&path=%2Fws#Node`);
    expect(renderLoonNode(node)).toContain('transport=ws,path="/ws",host="cdn.example.com",over-tls=true');
  });
  it("preserves IPv6 and normalized certificate pins", () => {
    const fingerprint = "AB:".repeat(31) + "AB";
    const node: ParsedNode = { ...base, server: "[2001:db8::1]", type: "trojan", password: "secret", "tls-fingerprint": fingerprint, "tls-pubkey-sha256": fingerprint };
    expect(renderLoonNode(node)).toContain("Trojan,2001:db8::1,443");
    expect(renderLoonNode(node)).toContain(`tls-cert-sha256=${"ab".repeat(32)},tls-pubkey-sha256=${"ab".repeat(32)}`);
    expect(() => renderLoonNode({ ...node, "tls-fingerprint": "bad-secret" })).toThrow("TLS 证书指纹");
  });
  it("identifies unsupported categories without including submitted values", () => {
    expect(() => renderLoonNode({ ...ss, plugin: "secret-plugin" })).toThrow("不支持的选项 plugin");
    expect(() => renderLoonNode({ ...ss, "secret-key": "secret-value" })).toThrow("扩展字段");
    expect(() => renderLoonNode({ ...base, type: "ssr", cipher: "none", password: "secret", protocol: "origin", obfs: "plain" })).toThrow("Loon ssr");
    expect(() => renderLoonNode({ ...base, type: "http", udp: true })).toThrow("HTTP 不支持 UDP");
    expect(renderLoonNode({ ...base, type: "http", udp: false })).toBe("香港 🇭🇰 = http,example.com,443");
    expect(renderLoonNode({ ...ss, "udp-over-tcp": true })).toContain("udp-over-tcp=true");
  });
  it.each([
    { network: "h2" }, { network: "xhttp" },
    { "ws-opts": [] }, { "ws-opts": { path: 12 } },
    { "ws-opts": { headers: [] } }, { "ws-opts": { headers: { Host: "a", Cookie: "secret" } } },
    { "ws-opts": { extra: true } }, { tls: "yes" },
    { flow: "xtls-rprx-vision" }, { "skip-cert-verify": "false" },
    { "client-fingerprint": "random" }, { encryption: "AES" },
    { "reality-opts": [] }, { "reality-opts": { "public-key": "short" } },
    { "reality-opts": { "public-key": "LgJ9bNTyUqBLFkDA12-QgEL7c1yQ1ztk-V1Q-3OLXSk", "short-id": "abc" } },
    { "reality-opts": { "public-key": "LgJ9bNTyUqBLFkDA12-QgEL7c1yQ1ztk-V1Q-3OLXSk", "spider-x": "/" } },
  ])("rejects unsupported VLESS options safely %j", (patch: Record<string, unknown>) => {
    const node: ParsedNode = { ...base, type: "vless", uuid, tls: true, network: "ws", ...patch };
    expect(() => renderLoonNode(node)).toThrow("Loon");
  });
  it.each([
    { port: -1 }, { port: 65536 }, { port: 1.2 },
    { server: "[invalid]" }, { server: "2001:db8::invalid" },
    { cipher: "unsupported" }, { udp: "yes" }, { tfo: 1 },
  ])("rejects malformed common options %j", (patch: Record<string, unknown>) => {
    expect(() => renderLoonNode({ ...ss, ...patch })).toThrow("Loon");
  });
  it("handles absent optional fields and rejects incompatible TLS fields", () => {
    const vmess: ParsedNode = { ...base, type: "vmess", uuid, cipher: "auto", alterId: 0 };
    expect(renderLoonNode({ ...vmess, alterId: undefined })).toContain("alterId=0");
    expect(() => renderLoonNode({ ...vmess, alterId: -1 })).toThrow("alterId");
    expect(() => renderLoonNode({ ...vmess, cipher: "unknown" })).toThrow("cipher");
    const trojan: ParsedNode = { ...base, type: "trojan", password: "secret" };
    expect(() => renderLoonNode({ ...trojan, tls: false })).toThrow("tls");
    expect(() => renderLoonNode({ ...trojan, sni: "a", servername: "b" })).toThrow("servername");
    expect(() => renderLoonNode({ ...trojan, alpn: [] })).toThrow("alpn");
    expect(() => renderLoonNode({ ...base, type: "https", tls: false })).toThrow("tls");
    expect(() => renderLoonNode({ ...base, type: "socks5", username: "user" })).toThrow("password");
    expect(() => renderLoonNode({ ...base, type: "hysteria2", password: "p", "client-fingerprint": "chrome" })).toThrow("client-fingerprint");
    expect(renderLoonNode({ ...base, type: "socks5", tls: false, username: "", password: "" })).toContain('socks5,example.com,443,"","",over-tls=false');
    expect(renderLoonNode({ ...base, type: "vless", uuid, network: "ws", "ws-opts": { path: undefined, headers: {} } })).toContain("transport=ws");
  });
  it("checks Reality details only with an eligible TCP transport", () => {
    const node: ParsedNode = { ...base, type: "vless", uuid, tls: true, network: "tcp", servername: "example.com" };
    for (const reality of [[], { "public-key": "short" }, { "public-key": "LgJ9bNTyUqBLFkDA12-QgEL7c1yQ1ztk-V1Q-3OLXSk", "short-id": "abc" }, { "public-key": "LgJ9bNTyUqBLFkDA12-QgEL7c1yQ1ztk-V1Q-3OLXSk", extra: true }]) {
      const patch: Record<string, unknown> = { "reality-opts": reality };
      expect(() => renderLoonNode({ ...node, ...patch })).toThrow("Loon");
    }
    const reality = { "public-key": "LgJ9bNTyUqBLFkDA12-QgEL7c1yQ1ztk-V1Q-3OLXSk" };
    expect(() => renderLoonNode({ ...node, servername: undefined, "reality-opts": reality })).toThrow("reality-opts");
    expect(renderLoonNode({ ...node, "reality-opts": reality })).toContain('public-key="LgJ9bNTyUqBLFkDA12-QgEL7c1yQ1ztk-V1Q-3OLXSk"');
    const extension: Record<string, unknown> = { type: "secret-protocol" };
    expect(() => renderLoonNode({ ...ss, ...extension })).toThrow("Loon 扩展协议");
    const vmess: ParsedNode = { ...base, type: "vmess", uuid, cipher: "auto", alterId: 0 };
    expect(() => renderLoonNode({ ...vmess, alterId: 65536 })).toThrow("alterId");
    const invalid: Record<string, unknown> = { alterId: "secret" };
    expect(() => renderLoonNode({ ...vmess, ...invalid })).toThrow("alterId");
  });
  it("renders VLESS, Trojan, HTTP and SOCKS credentials", () => {
    expect(renderLoonNode({ ...base, type: "vless", uuid })).toContain(`VLESS,example.com,443,"${uuid}",transport=tcp,over-tls=false`);
    expect(renderLoonNode({ ...base, type: "trojan", password: "secret", alpn: ["h2", "http/1.1"] })).toContain('alpn="h2,http/1.1"');
    expect(renderLoonNode({ ...base, type: "http", tls: true, username: "user,name", password: "secret" })).toContain('https,example.com,443,"user,name","secret"');
    expect(renderLoonNode({ ...base, type: "socks5", tls: true })).toContain('socks5,example.com,443,over-tls=true');
  });
  it.each(["name\n[Rule]", "[Rule]", "a=b", "a,b", 'a"b', "a\\b", " a", "a\u2028b"])("rejects unsafe policy name %j", (name) => {
    expect(() => validateLoonName(name)).toThrow("Loon");
  });
  it.each([
    { password: 'secret"\n[Rule]' }, { port: 0 }, { server: "example.com,udp=true" },
    { plugin: "v2ray-plugin" }, { "dialer-proxy": "chain" }, { unknown: true },
    { "skip-cert-verify": false }, { "udp-over-tcp-version": 2 },
  ])("rejects fields it cannot preserve without exposing values", (patch) => {
    expect(() => renderLoonNode({ ...ss, ...patch })).toThrow(/Loon/);
  });
  it("matches the documented Reality fields and rejects lossy extensions", () => {
    const reality: ParsedNode = { ...base, type: "vless", uuid, tls: true, servername: "www.example.com", flow: "xtls-rprx-vision", "client-fingerprint": "chrome", "reality-opts": { "public-key": "LgJ9bNTyUqBLFkDA12-QgEL7c1yQ1ztk-V1Q-3OLXSk", "short-id": "164168844958a16d" } };
    const line = renderLoonNode(reality);
    expect(line).toContain('flow=xtls-rprx-vision,public-key="LgJ9bNTyUqBLFkDA12-QgEL7c1yQ1ztk-V1Q-3OLXSk",short-id="164168844958a16d"');
    expect(line).toContain("tls-profile=chrome,sni=www.example.com");
    expect(() => renderLoonNode({ ...reality, tls: false })).toThrow("Loon");
    expect(() => renderLoonNode({ ...reality, "reality-opts": { "public-key": "LgJ9bNTyUqBLFkDA12-QgEL7c1yQ1ztk-V1Q-3OLXSk", "support-x25519mlkem768": true } })).toThrow("Loon");
  });
  it("renders basic Hysteria2 and rejects bandwidth and obfuscation options", () => {
    const node: ParsedNode = { ...base, type: "hysteria2", password: "secret", sni: "hy.example.com", "skip-cert-verify": false, alpn: ["h3"] };
    expect(renderLoonNode(node)).toBe('香港 🇭🇰 = Hysteria2,example.com,443,"secret",udp=true,block-quic=false,skip-cert-verify=false,sni=hy.example.com,alpn="h3"');
    expect(() => renderLoonNode({ ...node, up: "10 Mbps" })).toThrow("Loon");
    expect(() => renderLoonNode({ ...node, obfs: "salamander" })).toThrow("Loon");
  });
  it("rejects unsupported transports and WebSocket headers", () => {
    const node: ParsedNode = { ...base, type: "vless", uuid, network: "ws", "ws-opts": { headers: { Authorization: "secret" } } };
    expect(() => renderLoonNode(node)).toThrow("Loon");
    expect(() => renderLoonNode({ ...node, network: "grpc" })).toThrow("Loon");
  });
});
