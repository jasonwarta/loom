/**
 * Read-only HTTP dashboard transport (ARCHITECTURE section 26: "additional
 * client surfaces ... over the same verbs"). A second transport over the SAME
 * control plane the MCP server uses -- it adds NO logic and, deliberately,
 * exposes ONLY the read verbs (QueryQueue/QueryRegistry/InspectWorker/GetResult/
 * status). There is no route that mutates platform state, so a browser cannot
 * dispatch, cancel, or resume; the dashboard observes, it does not operate.
 *
 * Like the MCP server it lives ABOVE the adapter boundary and imports no
 * backend -- enforced by test/architecture.test.ts.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DaemonRuntime } from "../daemon/runtime.js";
import { DASHBOARD_HTML } from "./dashboard.js";

export interface DashboardOptions {
  /** TCP port; 0 lets the OS choose (useful in tests). Default 4319. */
  readonly port?: number;
  /**
   * Bind address. Defaults to loopback only -- the platform is single-team,
   * self-hosted (ARCHITECTURE section 3/24), and the dashboard is unauthenticated,
   * so it must not listen on a public interface by default.
   */
  readonly host?: string;
}

export interface DashboardHandle {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Start the dashboard HTTP server over a running DaemonRuntime. Returns a handle
 * with the resolved port (meaningful when `port: 0`) and a close().
 */
export function startDashboard(rt: DaemonRuntime, opts: DashboardOptions = {}): Promise<DashboardHandle> {
  const cp = rt.controlPlane;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4319;

  const server = createServer((req, res) => {
    // Read-only surface: anything that isn't a GET is rejected outright, so the
    // "observe, never operate" guarantee is enforced at the transport, not just
    // by which routes happen to exist.
    if (req.method !== "GET") {
      return send(res, 405, { error: "method not allowed; the dashboard is read-only" });
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(DASHBOARD_HTML);
        return;
      }
      if (path === "/api/queue") return send(res, 200, cp.queryQueue());
      if (path === "/api/status") return send(res, 200, cp.getStatus());
      if (path === "/api/registry") return send(res, 200, cp.queryRegistry());

      const worker = matchParam(path, "/api/worker/");
      if (worker !== null) {
        const detail = cp.inspectWorker(worker);
        return detail ? send(res, 200, detail) : send(res, 404, { error: "no such worker: " + worker });
      }
      const taskId = matchParam(path, "/api/result/");
      if (taskId !== null) {
        const view = cp.getResult(taskId);
        return view ? send(res, 200, view) : send(res, 404, { error: "no such task: " + taskId });
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
  });

  return new Promise<DashboardHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const resolved = (server.address() as AddressInfo).port;
      resolve({
        port: resolved,
        host,
        url: `http://${host}:${resolved}/`,
        close: () =>
          new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

/** Extract and decode a single trailing path segment after `prefix`, or null if it doesn't match. */
function matchParam(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest.length === 0 || rest.includes("/")) return null;
  return decodeURIComponent(rest);
}

function send(res: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body ?? null));
}
