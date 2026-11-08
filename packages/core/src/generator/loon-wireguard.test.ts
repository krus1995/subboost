import { describe, expect, it } from "vitest";
import type { ParsedNode } from "../types/node";
import { renderLoonNode } from "./loon-node";

const privateKey = "A".repeat(43) + "=";
const publicKey = "B".repeat(43) + "=";
const presharedKey = "C".repeat(43) + "=";
const base: ParsedNode = { name: "Synthetic WG", type: "wireguard", server: "wg.example.invalid", port: 51820, "private-key": privateKey, "public-key": publicKey, ip: "10.0.0.2" };

describe("Loon WireGuard parameter preservation", () => {
  it("derives default routes from the available interface families and preserves UDP settings", () => {
    const ipv4 = renderLoonNode(base);
    expect(ipv4).toContain('interface-ip=10.0.0.2,mtu=1408,keepalive=0');
    expect(ipv4).toContain('allowed-ips="0.0.0.0/0"');
    expect(ipv4).toContain('udp=true,block-quic=false');
    const ipv6 = renderLoonNode({ ...base, ip: undefined, ipv6: "fd00::2", mtu: 1420, keepalive: 10, udp: false });
    expect(ipv6).toContain('interface-ipv6=fd00::2,mtu=1420,keepalive=10');
    expect(ipv6).toContain('allowed-ips="::/0"');
    expect(ipv6).toContain('udp=false');
    expect(ipv6).not.toContain('block-quic');
    expect(renderLoonNode({ ...base, ipv6: "fd00::2", keepalive: 25, "persistent-keepalive": 25 })).toContain('allowed-ips="0.0.0.0/0,::/0"');
  });

  it("preserves separate multi-peer routes, preshared keys and reserved bytes", () => {
    const peers = [
      { server: "[2001:db8::1]", port: 51820, "public-key": publicKey, "pre-shared-key": presharedKey, reserved: [0, 127, 255], "allowed-ips": ["10.0.0.0/8"] },
      { server: "second.example.invalid", port: 65535, "public-key": publicKey, "allowed-ips": ["fd00::/64", "192.0.2.0/24"] },
    ];
    const line = renderLoonNode({ ...base, server: undefined, port: undefined, "public-key": undefined, peers });
    expect(line).toContain(`endpoint=[2001:db8::1]:51820,preshared-key="${presharedKey}",reserved=[0,127,255],allowed-ips="10.0.0.0/8"`);
    expect(line).toContain('endpoint=second.example.invalid:65535,allowed-ips="fd00::/64,192.0.2.0/24"');
    expect(renderLoonNode({ ...base, "remote-dns-resolve": false })).not.toContain('dns=');
    expect(renderLoonNode({ ...base, "remote-dns-resolve": true, dns: ["fd00::53"] })).toContain('dnsv6=fd00::53');
  });

  it.each([
    { "private-key": 1 }, { "private-key": "" }, { "private-key": "bad\nkey" },
    { mtu: "1408" }, { mtu: 575 }, { mtu: 65536 }, { mtu: 1408.5 },
    { keepalive: -1 }, { keepalive: 65536 }, { keepalive: 10, "persistent-keepalive": 20 },
    { ip: "256.0.0.1" }, { ip: "010.0.0.2" }, { ip: "not-an-ip" },
    { "remote-dns-resolve": "true" }, { dns: "1.1.1.1", "remote-dns-resolve": true },
    { dns: ["fd00::1", "fd00::2"], "remote-dns-resolve": true },
    { dns: ["1.1.1.1"] }, { dns: ["bad-address"], "remote-dns-resolve": true },
    { server: "host,other" }, { server: "[2001:db8::1" }, { server: 42 },
    { port: 0 }, { port: 65536 }, { "public-key": "invalid" }, { "pre-shared-key": "invalid" },
    { reserved: "1,2,3" }, { reserved: [1, 2] }, { reserved: [0, -1, 0] },
    { "allowed-ips": "0.0.0.0/0" }, { "allowed-ips": [] }, { "allowed-ips": ["10.0.0.0"] },
    { "allowed-ips": ["10.0.0.0/8/extra"] }, { "allowed-ips": ["10.0.0.0/no"] },
    { "allowed-ips": ["0.0.0.0/33"] }, { "allowed-ips": ["256.0.0.0/8"] },
    { peers: "invalid" }, { peers: [] }, { peers: [null] }, { peers: [[]] }, { peers: [1] },
    { peers: [{ server: "wg.example.invalid", port: 51820, "public-key": publicKey }] },
    { peers: [{ server: "wg.example.invalid", port: 51820, "public-key": publicKey, "allowed-ips": ["0.0.0.0/0"], extra: true }] },
    { udp: "false" },
  ])("rejects invalid or unsupported settings without silently dropping them: %j", (patch) => {
    expect(() => renderLoonNode({ ...base, ...patch })).toThrow("Loon wireguard");
  });
});
