import type { ParsedNode } from "../types/node";
import { LoonConversionError } from "./loon-error";

function fail(): never {
  throw new LoonConversionError("Loon wireguard 节点转换失败（WireGuard 参数无效或不受支持）");
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f-\u009f\u2028\u2029"\\]/u.test(value)) fail();
  return value;
}

function key(value: unknown): string {
  const result = string(value);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(result)) fail();
  return `"${result}"`;
}

function integer(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) fail();
  return String(value);
}

function ip(value: unknown, ipv6: boolean): string {
  const result = string(value);
  if (ipv6) {
    try { new URL(`http://[${result}]/`); } catch { fail(); }
  } else if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(result) || result.split(".").some(part => Number(part) > 255 || (part.length > 1 && part.startsWith("0")))) fail();
  return result;
}

function addresses(value: unknown): string {
  if (!Array.isArray(value) || !value.length) fail();
  return value.map(item => {
    const address = string(item);
    const [host, prefix, extra] = address.split("/");
    if (extra !== undefined || prefix === undefined || !/^\d+$/.test(prefix)) fail();
    const ipv6 = host.includes(":");
    ip(host, ipv6);
    if (Number(prefix) > (ipv6 ? 128 : 32)) fail();
    return address;
  }).join(",");
}

export function renderLoonWireGuard(node: ParsedNode, name: string): string {
  const data: Record<string, unknown> = node;
  const consumed = new Set(["name", "type", "_originName", "_sourceIds", "_meta"]);
  const take = (field: string): unknown => { consumed.add(field); return data[field]; };
  const options = [`private-key=${key(take("private-key"))}`];
  const ipv4 = take("ip");
  const ipv6 = take("ipv6");
  if (ipv4 === undefined && ipv6 === undefined) fail();
  if (ipv4 !== undefined) options.push(`interface-ip=${ip(ipv4, false)}`);
  if (ipv6 !== undefined) options.push(`interface-ipv6=${ip(ipv6, true)}`);
  const mtu = take("mtu") ?? 1408;
  options.push(`mtu=${integer(mtu, 576, 65535)}`);
  const keepalive = take("keepalive");
  const persistent = take("persistent-keepalive");
  if (keepalive !== undefined && persistent !== undefined && keepalive !== persistent) fail();
  options.push(`keepalive=${integer(keepalive ?? persistent ?? 0, 0, 65535)}`);
  const dns = take("dns");
  const remoteDns = take("remote-dns-resolve");
  if (remoteDns !== undefined && typeof remoteDns !== "boolean") fail();
  if (dns !== undefined) {
    if (!Array.isArray(dns) || remoteDns !== true) fail();
    let hasV4 = false;
    let hasV6 = false;
    for (const entry of dns) {
      const address = string(entry);
      const v6 = address.includes(":");
      if ((v6 && hasV6) || (!v6 && hasV4)) fail();
      options.push(`${v6 ? "dnsv6" : "dns"}=${ip(address, v6)}`);
      if (v6) hasV6 = true; else hasV4 = true;
    }
  }
  const peers = take("peers");
  const peerKeys = ["server", "port", "public-key", "pre-shared-key", "reserved", "allowed-ips"];
  const topPeer: Record<string, unknown> = {};
  for (const field of peerKeys) topPeer[field] = take(field);
  const renderPeer = (peer: Record<string, unknown>, full: boolean): string => {
    if (Object.entries(peer).some(([field, value]) => value !== undefined && !peerKeys.includes(field))) fail();
    let server = string(peer.server);
    if (server.startsWith("[") && server.endsWith("]")) server = server.slice(1, -1);
    if (server.includes(":")) server = `[${ip(server, true)}]`;
    else if (/[\s,=\[\]#;{}/:@?]/u.test(server)) fail();
    const port = integer(peer.port, 1, 65535);
    const result = [`public-key=${key(peer["public-key"])}`, `endpoint=${server}:${port}`];
    if (peer["pre-shared-key"] !== undefined) result.push(`preshared-key=${key(peer["pre-shared-key"])}`);
    const reserved = peer.reserved;
    if (reserved !== undefined) {
      if (!Array.isArray(reserved) || reserved.length !== 3) fail();
      result.push(`reserved=[${reserved.map(value => integer(value, 0, 255)).join(",")}]`);
    }
    const allowed = peer["allowed-ips"];
    if (full && allowed === undefined) fail();
    const defaults = [ipv4 !== undefined ? "0.0.0.0/0" : undefined, ipv6 !== undefined ? "::/0" : undefined].filter(value => value !== undefined).join(",");
    result.push(`allowed-ips="${allowed === undefined ? defaults : addresses(allowed)}"`);
    return `{${result.join(",")}}`;
  };
  if (peers !== undefined) {
    if (!Array.isArray(peers) || !peers.length) fail();
    const rendered = peers.map(peer => {
      if (!peer || typeof peer !== "object" || Array.isArray(peer)) fail();
      return renderPeer(peer, true);
    });
    options.push(`peers=[${rendered.join(",")}]`);
  } else options.push(`peers=[${renderPeer(topPeer, false)}]`);
  const udp = take("udp") ?? true;
  if (typeof udp !== "boolean") fail();
  options.push(`udp=${udp}`);
  if (udp) options.push("block-quic=false");
  for (const [field, value] of Object.entries(data)) {
    if (value !== undefined && !consumed.has(field)) fail();
  }
  return `${name} = WireGuard,${options.join(",")}`;
}
