import { describe, expect, it } from "vitest";
import type { ParsedNode } from "../types/node";
import { renderLoonNode } from "./loon-node";
import { isLoonIpv6Literal } from "./loon-ip";

const base = { name: "Synthetic", server: "example.invalid", port: 443 };
const vless: ParsedNode = { ...base, type: "vless", uuid: "00000000-0000-4000-8000-000000000000" };
const ss: ParsedNode = { ...base, type: "ss", cipher: "aes-128-gcm", password: "synthetic" };
const anytls: ParsedNode = { ...base, type: "anytls", password: "synthetic" };
const hy2: ParsedNode = { ...base, type: "hysteria2", password: "synthetic" };
const ssr: ParsedNode = { ...base, type: "ssr", cipher: "aes-256-cfb", password: "synthetic", protocol: "origin", obfs: "plain" };

describe("Loon node option validation", () => {
  it.each(["::", "::ffff:192.0.2.1", "2001:db8:0:1::1"])("accepts a complete IPv6 literal %s", value => {
    expect(isLoonIpv6Literal(value)).toBe(true);
  });
  it.each(["", "example.invalid", "2001:db8:::1", "2001:db8::g", "2001:db8::1/64"])("rejects an invalid IPv6 literal %s", value => {
    expect(isLoonIpv6Literal(value)).toBe(false);
  });
  it.each([undefined, null, false, [], {}, { mode: "unknown" }, { mode: "tls", path: "/tunnel" }, { mode: "http", host: 1 }])("rejects unrepresentable Simple Obfs options %j", opts => {
    expect(() => renderLoonNode({ ...ss, plugin: "obfs", "plugin-opts": opts })).toThrow("Loon");
  });
  it("preserves TLS Simple Obfs and absent optional values", () => {
    expect(renderLoonNode({ ...ss, plugin: "obfs", "plugin-opts": { host: "cdn.example.invalid", mode: "tls", unused: undefined } })).toContain('obfs-name=tls,obfs-host="cdn.example.invalid"');
  });
  it.each<Record<string, unknown>>([
    { cipher: "2022-blake3-aes-128-gcm" }, { cipher: "aes-128-gcm" }, { obfs: "tls1.2_ticket_fastauth" }, { cipher: "unknown" }, { protocol: "unknown" }, { obfs: "unknown" }, { "protocol-param": 123 }, { "obfs-param": false },
  ])("rejects unsupported SSR options %j", patch => {
    expect(() => renderLoonNode({ ...ssr, ...patch })).toThrow("Loon");
  });
  it.each(["none", "rc4-md5-6"])("preserves the SSR encryption method %s", cipher => {
    expect(renderLoonNode({ ...ssr, cipher })).toContain(`,${cipher},"synthetic",protocol=origin`);
  });
  it.each(["origin", "auth_sha1", "auth_sha1_v2", "auth_sha1_v4", "auth_aes128_md5", "auth_aes128_sha1", "auth_chain_a", "auth_chain_b"])("preserves the SSR protocol %s", protocol => {
    expect(renderLoonNode({ ...ssr, protocol, "protocol-param": "" })).toContain(`protocol=${protocol},obfs=plain,protocol-param=""`);
  });
  it.each([undefined, {}, { method: undefined, path: undefined, headers: undefined }, { headers: {} }])("exports default HTTP options %j", opts => {
    expect(renderLoonNode({ ...vless, network: "http", "http-opts": opts })).toContain("transport=http,over-tls=false");
  });
  it.each([null, [], false, { path: "/tunnel" }, { path: [] }, { path: [123] }, { headers: null }, { headers: [] }, { headers: false }, { headers: { Host: ["a"], Cookie: ["b"] } }, { headers: { Host: "a" } }, { headers: { Host: [] } }, { headers: { Host: [123] } }])("rejects lossy or malformed HTTP options %j", opts => {
    expect(() => renderLoonNode({ ...vless, network: "http", "http-opts": opts })).toThrow("Loon");
  });
  it("exports VMess HTTP with an exact lowercase Host header", () => {
    expect(renderLoonNode({ ...base, type: "vmess", uuid: vless.uuid, cipher: "auto", alterId: 0, network: "http", "http-opts": { path: ["/"], headers: { host: ["cdn.example.invalid"] } } })).toContain('transport=http,alterId=0,path="/",host="cdn.example.invalid"');
  });
  it.each<Record<string, unknown>>([
    { "idle-session-timeout": -1 }, { "idle-session-timeout": 1.5 }, { "idle-session-timeout": "30" }, { "idle-session-timeout": null }, { "idle-session-timeout": Number.NaN }, { "idle-session-timeout": Infinity }, { "idle-session-timeout": Number.MAX_SAFE_INTEGER + 1 }, { "max-stream-count": 0 }, { "max-stream-count": false },
  ])("rejects invalid AnyTLS session settings %j", patch => {
    expect(() => renderLoonNode({ ...anytls, ...patch })).toThrow("Loon");
  });
  it.each([1, Number.MAX_SAFE_INTEGER])("preserves supported AnyTLS session boundaries %s", value => {
    expect(renderLoonNode({ ...anytls, "idle-session-timeout": value, "max-stream-count": value })).toContain(`idle-session-timeout=${value},max-stream-count=${value}`);
  });
  it.each<Record<string, unknown>>([
    { tls: false }, { tls: "true" }, { "obfs-password": "synthetic" }, { down: 25 }, { down: "0" }, { down: "9".repeat(400) }, { ports: "0" }, { ports: "invalid" }, { ports: "443," }, { "hop-interval": 5 }, { ports: "443", "hop-interval": "5-10" }, { ports: "443", "hop-interval": true }, { ports: "443", "hop-interval": Infinity },
  ])("rejects invalid Hysteria2 settings %j", patch => {
    expect(() => renderLoonNode({ ...hy2, ...patch })).toThrow("Loon");
  });
  it.each([1, 0.5, "1", "0.5s"])("preserves a fixed Hysteria2 hopping interval %s", interval => {
    const text = renderLoonNode({ ...hy2, tls: true, down: "0.5", ports: "1,65535,2-65534", "hop-interval": interval });
    expect(text).toContain('download-bandwidth=0.5,server-ports="1,65535,2:65534"');
    expect(text).toContain(`hop-interval=${typeof interval === "string" ? interval.replace(/s$/, "") : interval}`);
  });
  it.each<Record<string, unknown>>([
    { "shadow-tls-sni": "tls.example.invalid" }, { "shadow-tls-version": 3 }, { "udp-port": 8443 },
    { "shadow-tls-password": "synthetic", "shadow-tls-sni": "tls.example.invalid", "shadow-tls-version": 3, "udp-port": 0 },
    { "shadow-tls-password": "synthetic", "shadow-tls-sni": "tls.example.invalid", "shadow-tls-version": 3, "udp-port": 65536 },
    { "shadow-tls-password": "synthetic", "shadow-tls-sni": "tls.example.invalid", "shadow-tls-version": 3, "udp-port": "443" },
  ])("rejects incomplete or invalid ShadowTLS settings %j", patch => {
    expect(() => renderLoonNode({ ...ss, ...patch })).toThrow("Loon");
  });
  it("preserves ShadowTLS v2 and rejects a non-TCP transport", () => {
    const shadow = { "shadow-tls-password": "synthetic", "shadow-tls-sni": "tls.example.invalid", "shadow-tls-version": 2 };
    expect(renderLoonNode({ ...ss, ...shadow })).toContain("shadow-tls-version=2,udp=true");
    expect(() => renderLoonNode({ ...vless, network: "ws", ...shadow })).toThrow("ShadowTLS 需要");
  });
  it.each<Record<string, unknown>>([{ tls: "true" }, { password: "synthetic" }])("rejects malformed HTTP proxy TLS or authentication %j", patch => {
    expect(() => renderLoonNode({ ...base, type: "http", ...patch })).toThrow("Loon");
  });
});
