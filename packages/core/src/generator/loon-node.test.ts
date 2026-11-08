import { describe, expect, it } from "vitest";
import type { ParsedNode } from "../types/node";
import { parseConfigLine } from "../parser/config-line-parser";
import { renderLoonNode, validateLoonName } from "./loon-node";

const base = { name: "香港 🇭🇰", server: "example.com", port: 443 };
const uuid = "52396e06-041a-4cc2-be5c-8525eb457809";
const ss: ParsedNode = { ...base, type: "ss", cipher: "aes-128-gcm", password: "pass,word" };

describe("Loon native nodes", () => {
  it("quotes comma credentials and preserves Unicode and internal source metadata", () => {
    expect(renderLoonNode({ ...ss, _originName: "original", _sourceIds: ["source"], _meta: {} }))
      .toBe('香港 🇭🇰 = Shadowsocks,example.com,443,aes-128-gcm,"pass,word"');
  });
  it("uses native protocol syntax and the existing parser can read it", () => {
    const node: ParsedNode = { ...base, type: "vmess", uuid, alterId: 0, cipher: "auto", tls: true, servername: "tls.example.com", "skip-cert-verify": false, network: "ws", "ws-opts": { path: "/socket", headers: { Host: "cdn.example.com" } } };
    const line = renderLoonNode(node);
    expect(line).toContain('VMess,example.com,443,auto,"52396e06-041a-4cc2-be5c-8525eb457809",transport=ws,alterId=0,path="/socket",host="cdn.example.com",over-tls=true');
    expect(parseConfigLine(line)).toMatchObject({ type: "vmess", uuid, tls: true, "skip-cert-verify": false, network: "ws" });
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
    expect(() => renderLoonNode({ ...ss, ...patch })).toThrow(/^Loon 无法可靠表示此节点的协议、字段或参数，请检查节点配置$/);
  });
  it("matches the documented Reality fields and rejects lossy extensions", () => {
    const reality: ParsedNode = { ...base, type: "vless", uuid, tls: true, servername: "www.example.com", flow: "xtls-rprx-vision", "client-fingerprint": "chrome", "reality-opts": { "public-key": "LgJ9bNTyUqBLFkDA12-QgEL7c1yQ1ztk-V1Q-3OLXSk", "short-id": "164168844958a16d" } };
    const line = renderLoonNode(reality);
    expect(line).toContain('flow=xtls-rprx-vision,public-key="LgJ9bNTyUqBLFkDA12-QgEL7c1yQ1ztk-V1Q-3OLXSk",short-id="164168844958a16d"');
    expect(line).toContain("tls-profile=chrome,sni=www.example.com");
    expect(() => renderLoonNode({ ...reality, tls: false })).toThrow("Loon");
    expect(() => renderLoonNode({ ...reality, "reality-opts": { ...reality["reality-opts"], "support-x25519mlkem768": true } })).toThrow("Loon");
  });
  it("renders basic Hysteria2 and rejects bandwidth and obfuscation options", () => {
    const node: ParsedNode = { ...base, type: "hysteria2", password: "secret", sni: "hy.example.com", "skip-cert-verify": false, alpn: ["h3"] };
    expect(renderLoonNode(node)).toBe('香港 🇭🇰 = Hysteria2,example.com,443,"secret",skip-cert-verify=false,sni=hy.example.com,alpn="h3"');
    expect(() => renderLoonNode({ ...node, up: "10 Mbps" })).toThrow("Loon");
    expect(() => renderLoonNode({ ...node, obfs: "salamander" })).toThrow("Loon");
  });
  it("rejects unsupported transports and WebSocket headers", () => {
    const node: ParsedNode = { ...base, type: "vless", uuid, network: "ws", "ws-opts": { headers: { Authorization: "secret" } } };
    expect(() => renderLoonNode(node)).toThrow("Loon");
    expect(() => renderLoonNode({ ...node, network: "grpc" })).toThrow("Loon");
  });
});

