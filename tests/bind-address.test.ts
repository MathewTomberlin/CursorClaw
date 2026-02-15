import * as dns from "node:dns/promises";
import { describe, expect, it, vi } from "vitest";

import { isSafeBindAddress, setDnsLookupForTests, validateBindAddress } from "../src/security.js";

describe("gateway bind address", () => {
  describe("isSafeBindAddress", () => {
    it("allows loopback IPv4", () => {
      expect(isSafeBindAddress("127.0.0.1")).toBe(true);
      expect(isSafeBindAddress("127.255.255.255")).toBe(true);
    });

    it("allows link-local IPv4", () => {
      expect(isSafeBindAddress("169.254.0.1")).toBe(true);
      expect(isSafeBindAddress("169.254.255.255")).toBe(true);
    });

    it("allows private IPv4", () => {
      expect(isSafeBindAddress("10.0.0.1")).toBe(true);
      expect(isSafeBindAddress("172.16.0.1")).toBe(true);
      expect(isSafeBindAddress("192.168.1.1")).toBe(true);
    });

    it("allows Tailscale CGNAT range (100.64.0.0/10)", () => {
      expect(isSafeBindAddress("100.64.0.1")).toBe(true);
      expect(isSafeBindAddress("100.127.255.255")).toBe(true);
    });

    it("allows IPv6 loopback and link-local", () => {
      expect(isSafeBindAddress("::1")).toBe(true);
      expect(isSafeBindAddress("fe80::1")).toBe(true);
    });

    it("rejects 0.0.0.0", () => {
      expect(isSafeBindAddress("0.0.0.0")).toBe(false);
      expect(isSafeBindAddress("0.1.0.0")).toBe(false);
    });

    it("rejects public IPv4", () => {
      expect(isSafeBindAddress("8.8.8.8")).toBe(false);
      expect(isSafeBindAddress("1.1.1.1")).toBe(false);
    });

    it("rejects invalid or empty", () => {
      expect(isSafeBindAddress("")).toBe(false);
      expect(isSafeBindAddress("not-an-ip")).toBe(false);
    });
  });

  describe("validateBindAddress", () => {
    it("accepts safe IPv4 address", async () => {
      await expect(validateBindAddress("127.0.0.1")).resolves.toBeUndefined();
      await expect(validateBindAddress("100.64.0.5")).resolves.toBeUndefined();
    });

    it("accepts safe IPv6 address", async () => {
      await expect(validateBindAddress("::1")).resolves.toBeUndefined();
    });

    it("rejects empty or whitespace", async () => {
      await expect(validateBindAddress("")).rejects.toThrow(/non-empty/);
      await expect(validateBindAddress("   ")).rejects.toThrow(/non-empty/);
    });

    it("rejects 0.0.0.0 with clear message", async () => {
      await expect(validateBindAddress("0.0.0.0")).rejects.toThrow(/not allowed/);
      await expect(validateBindAddress("0.0.0.0")).rejects.toThrow(/gateway\.bind/);
    });

    it("rejects public IP with clear message", async () => {
      await expect(validateBindAddress("8.8.8.8")).rejects.toThrow(/not allowed/);
    });

    it("validates hostname by resolving and checking resolved IPs", async () => {
      const mockLookup = async (host: string) => {
        if (host === "localhost") return [{ address: "127.0.0.1", family: 4 }];
        if (host === "bad.example") return [{ address: "8.8.8.8", family: 4 }];
        throw new Error(`unknown host: ${host}`);
      };
      setDnsLookupForTests(mockLookup as unknown as typeof dns.lookup);
      try {
        await expect(validateBindAddress("localhost")).resolves.toBeUndefined();
        await expect(validateBindAddress("bad.example")).rejects.toThrow(/resolves to non-allowed/);
      } finally {
        setDnsLookupForTests(null);
      }
    });
  });
});
