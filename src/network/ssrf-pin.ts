import * as http from "node:http";
import * as https from "node:https";

import type { SafeFetchTarget } from "../security.js";

/**
 * Fetch a URL by connecting to the first resolved IP (DNS pinning) and sending
 * the original hostname in the Host header. Prevents DNS rebinding between
 * resolution and connect.
 */
export function fetchWithPinnedDns(
  target: SafeFetchTarget,
  pathWithQuery: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}> {
  const { url, resolvedAddresses } = target;
  const resolvedIp = resolvedAddresses[0];
  if (!resolvedIp) {
    return Promise.reject(new Error("no resolved address for pinned fetch"));
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const protocol = url.protocol === "https:" ? https : http;
  const port = url.port || (url.protocol === "https:" ? 443 : 80);
  const path = pathWithQuery || "/";

  return new Promise((resolve, reject) => {
    const req = protocol.request(
      {
        hostname: resolvedIp,
        port: Number(port),
        path,
        method: "GET",
        headers: {
          Host: url.hostname
        },
        rejectUnauthorized: true
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const headers = new Map<string, string>();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") {
              headers.set(key.toLowerCase(), value);
            } else if (Array.isArray(value)) {
              headers.set(key.toLowerCase(), value.join(", "));
            }
          }
          const body = Buffer.concat(chunks);
          const headersObj = {
            get(name: string): string | null {
              return headers.get(name.toLowerCase()) ?? null;
            }
          };
          resolve({
            status: res.statusCode ?? 0,
            headers: headersObj,
            arrayBuffer: () =>
              Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        req.destroy();
        reject(new Error("request aborted"));
      });
    }
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error("request timeout"));
    }, timeoutMs);
    req.on("close", () => clearTimeout(timeout));
    req.end();
  });
}
