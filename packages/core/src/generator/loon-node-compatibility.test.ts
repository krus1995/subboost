import { describe, expect, it } from "vitest";
import type { ParsedNode } from "../types/node";
import { parseAnyTLS } from "../parser/protocols/anytls";
import { renderLoonNode } from "./loon-node";
import { parseSubscription } from "../parser";
import { generateLoonConfig } from "./loon";

const base = { name: "Synthetic", server: "example.com", port: 443 };
const uuid = "52396e06-041a-4cc2-be5c-8525eb457809";
const vless: ParsedNode = { ...base, type: "vless", uuid, tls: true };
const privateKey = "A".repeat(43) + "=";
const publicKey = "B".repeat(43) + "=";

describe("documented Loon protocol intersection", () => {
  it.each(["2001:db8::1", "::1", "::ffff:192.0.2.1"])("preserves complete IPv6 literals %s", (address) => {
    expect(renderLoonNode({ ...vless, server: address })).toContain(`VLESS,${address},443`);
    expect(renderLoonNode({ ...vless, server: `[${address}]` })).toContain(`VLESS,${address},443`);
    const node: ParsedNode = { ...base, type: "wireguard", server: address, "private-key": privateKey, "public-key": publicKey, ipv6: address, "allowed-ips": [`${address}/128`] };
    const line = renderLoonNode(node);
    expect(line).toContain(`interface-ipv6=${address}`);
    expect(line).toContain(`endpoint=[${address}]:443`);
    expect(line).toContain(`allowed-ips="${address}/128"`);
  });
  it.each(["2001:db8::g", "2001:db8:::1", "2001:db8::1 ", "2001:db8::1/64"])("rejects malformed IPv6 fields %s", (address) => {
    expect(() => renderLoonNode({ ...vless, server: address })).toThrow("IPv6 地址");
    const node: ParsedNode = { ...base, type: "wireguard", "private-key": privateKey, "public-key": publicKey, ip: "10.0.0.2" };
    expect(() => renderLoonNode({ ...node, server: address })).toThrow("Loon wireguard");
    expect(() => renderLoonNode({ ...node, ipv6: address })).toThrow("Loon wireguard");
    expect(() => renderLoonNode({ ...node, "allowed-ips": [`${address}/128`] })).toThrow("Loon wireguard");
  });
  it("exports standard RAW share links through the complete subscription path", async () => {
    const parsed = parseSubscription([
      `vless://${uuid}@example.invalid:443?type=raw&security=tls#Synthetic-raw`,
      `vless://${uuid}@example.invalid:443?type=raw&headerType=http&security=tls&path=%2Ftunnel&host=cdn.example.invalid#Synthetic-raw-http`,
    ].join("\n"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes[0]).toMatchObject({ network: "tcp", tls: true });
    expect(parsed.nodes[1]).toMatchObject({ network: "http", "http-opts": { method: "GET", path: ["/tunnel"], headers: { Host: ["cdn.example.invalid"] } } });
    const config = await generateLoonConfig({ nodes: parsed.nodes, userConfig: { enabledGroups: [], experimentalCnUseCnRuleSet: false } }, async () => "example.invalid");
    expect(config).toContain(`Synthetic-raw = VLESS,example.invalid,443,"${uuid}",transport=tcp,over-tls=true`);
    expect(config).toContain(`Synthetic-raw-http = VLESS,example.invalid,443,"${uuid}",transport=http,path="/tunnel",host="cdn.example.invalid",over-tls=true`);
  });
  it("exports parsed AnyTLS and the saved TLS aliases", () => {
    const node = parseAnyTLS("anytls://synthetic@example.com:443?sni=tls.example.com&udp=1#Synthetic");
    expect(renderLoonNode({ ...node, tls: true, servername: "tls.example.com" })).toBe('Synthetic = AnyTLS,example.com,443,"synthetic",udp=true,block-quic=false,sni=tls.example.com');
    expect(renderLoonNode({ ...node, "idle-session-timeout": 0 })).toContain("idle-session-timeout=0");
    expect(() => renderLoonNode({ ...node, "min-idle-session": 1 })).toThrow("Loon");
    expect(() => renderLoonNode({ ...node, tls: false })).toThrow("Loon");
    expect(renderLoonNode({ ...node, "reality-opts": { "public-key": "A".repeat(43) }, "client-fingerprint": "chrome" })).toContain(`public-key="${"A".repeat(43)}"`);
  });
  it("preserves VLESS Reality with legacy VMess default fields", () => {
    const node = { ...vless, cipher: "auto", alterId: 0, encryption: "none", network: "tcp", flow: "xtls-rprx-vision", servername: "tls.example.com", "client-fingerprint": "chrome", "reality-opts": { "public-key": "A".repeat(43), "short-id": "aabb" } };
    const line = renderLoonNode(node);
    expect(line).toContain("transport=tcp,over-tls=true,flow=xtls-rprx-vision");
    expect(line).not.toContain("cipher=");
    expect(line).not.toContain("alterId=");
    expect(() => renderLoonNode({ ...node, cipher: "none" })).toThrow("Loon");
    expect(() => renderLoonNode({ ...node, alterId: 1 })).toThrow("Loon");
  });
  it("preserves supported HTTP headers and distinguishes HTTP/2", () => {
    const node = { ...vless, network: "http", "http-opts": { method: "GET", path: ["/tunnel"], headers: { Host: ["cdn.example.com"] } } };
    expect(renderLoonNode(node)).toContain('transport=http,path="/tunnel",host="cdn.example.com",over-tls=true');
    for (const opts of [{ method: "POST" }, { path: ["/a", "/b"] }, { headers: { Host: ["a", "b"] } }, { headers: { Cookie: ["secret"] } }, { extra: true }]) {
      expect(() => renderLoonNode({ ...node, "http-opts": opts })).toThrow("Loon");
    }
    for (const network of ["h2", "http2", "grpc", "xhttp", "httpupgrade"]) {
      expect(() => renderLoonNode({ ...vless, network })).toThrow("传输 network");
    }
    expect(renderLoonNode({ ...vless, network: "raw" })).toContain("transport=tcp");
    expect(() => renderLoonNode({ ...vless, network: "raw", "http-opts": {} })).toThrow("Loon");
  });
  it("rejects HTTPUpgrade and undocumented TLS profile aliases separately", () => {
    for (const fingerprint of ["safari", "ios", "edge", "random"]) {
      expect(() => renderLoonNode({ ...vless, "client-fingerprint": fingerprint })).toThrow("TLS 指纹");
    }
    expect(() => renderLoonNode({ ...vless, network: "ws", "ws-opts": { "v2ray-http-upgrade": true } })).toThrow("Loon");
  });
  it("preserves Hysteria2 salamander, download bandwidth and port hopping", () => {
    const node: ParsedNode = { ...base, type: "hysteria2", password: "synthetic", obfs: "salamander", "obfs-password": "synthetic-obfs", down: "25 Mbps", ports: "443,2000-3000", "hop-interval": "15s", sni: "tls.example.com" };
    expect(renderLoonNode(node)).toContain('salamander-password="synthetic-obfs",download-bandwidth=25,server-ports="443,2000:3000",hop-interval=15');
    for (const patch of [{ obfs: "unknown" }, { "obfs-password": undefined }, { down: "2 GBps" }, { ports: "65536" }, { ports: "10-1" }, { "hop-interval": 0 }, { up: "10 Mbps" }, { "obfs-min-packet-size": 10 }]) {
      expect(() => renderLoonNode({ ...node, ...patch })).toThrow("Loon");
    }
    expect(renderLoonNode({ ...node, fingerprint: "AB".repeat(32) })).toContain(`tls-cert-sha256=${"ab".repeat(32)}`);
    expect(() => renderLoonNode({ ...node, fingerprint: "AB".repeat(32), "tls-fingerprint": "CD".repeat(32) })).toThrow("指纹");
  });
  it("exports SSR and SS Simple Obfs with exact options", () => {
    expect(renderLoonNode({ ...base, type: "ssr", cipher: "aes-256-cfb", password: "synthetic", protocol: "auth_aes128_md5", "protocol-param": "9555:synthetic", obfs: "tls1.2_ticket_auth", "obfs-param": "cdn.example.com" })).toContain('ShadowsocksR,example.com,443,aes-256-cfb,"synthetic",protocol=auth_aes128_md5,obfs=tls1.2_ticket_auth');
    const node: ParsedNode = { ...base, type: "ss", cipher: "aes-128-gcm", password: "synthetic", plugin: "obfs", "plugin-opts": { mode: "http", host: "cdn.example.com", path: "/tunnel" } };
    expect(renderLoonNode(node)).toContain('obfs-name=http,obfs-host="cdn.example.com",obfs-uri="/tunnel"');
    expect(() => renderLoonNode({ ...node, "plugin-opts": { mode: "http", extra: true } })).toThrow("Loon");
  });
  it("preserves native ShadowTLS and rejects conflicting TLS", () => {
    const node: ParsedNode = { ...base, type: "ss", cipher: "aes-128-gcm", password: "synthetic", "shadow-tls-password": "synthetic-shadow", "shadow-tls-sni": "tls.example.com", "shadow-tls-version": 3, "udp-port": 8443 };
    expect(renderLoonNode(node)).toContain('shadow-tls-password="synthetic-shadow",shadow-tls-sni=tls.example.com,shadow-tls-version=3,udp-port=8443');
    expect(() => renderLoonNode({ ...node, "shadow-tls-version": 1 })).toThrow("Loon");
    expect(() => renderLoonNode({ ...vless, "shadow-tls-password": "secret", "shadow-tls-sni": "tls.example.com", "shadow-tls-version": 3 })).toThrow("ShadowTLS");
  });
  it("exports a standard WireGuard peer and interface", () => {
    const node: ParsedNode = { ...base, type: "wireguard", server: "2001:db8::1", "private-key": privateKey, "public-key": publicKey, ip: "10.0.0.2", ipv6: "fd00::2", "remote-dns-resolve": true, dns: ["1.1.1.1", "2606:4700:4700::1111"], reserved: [1, 2, 3], "persistent-keepalive": 25, "allowed-ips": ["0.0.0.0/0", "::/0"] };
    const line = renderLoonNode(node);
    expect(line).toContain("interface-ip=10.0.0.2,interface-ipv6=fd00::2,mtu=1408,keepalive=25,dns=1.1.1.1,dnsv6=2606:4700:4700::1111");
    expect(line).toContain('endpoint=[2001:db8::1]:443,reserved=[1,2,3],allowed-ips="0.0.0.0/0,::/0"');
    for (const patch of [{ "private-key": "invalid" }, { reserved: [1, 2, 256] }, { dns: ["1.1.1.1", "8.8.8.8"] }, { "allowed-ips": ["::/129"] }, { peers: [{}] }, { ip: undefined, ipv6: undefined }, { unknown: true }]) {
      expect(() => renderLoonNode({ ...node, ...patch })).toThrow("Loon wireguard");
    }
    expect(renderLoonNode({ ...node, server: undefined, port: undefined, peers: [{ server: "example.com", port: 51820, "public-key": publicKey, "allowed-ips": ["0.0.0.0/0"] }] })).toContain('endpoint=example.com:51820,allowed-ips="0.0.0.0/0"');
    expect(() => renderLoonNode({ ...node, "remote-dns-resolve": false })).toThrow("Loon wireguard");
  });
});
