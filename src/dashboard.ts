import { createReadStream } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DashboardJobs, message } from "./dashboard-jobs.ts";
import { loadReport } from "./dashboard-reports.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4178" },
    report: { type: "string", multiple: true, default: [] },
    config: { type: "string" },
    output: { type: "string", default: "benchmark-runs" },
  },
});
const port = Number(values.port);
if (!/^\d+$/.test(values.port) || port > 65535)
  throw new Error("Use --port with a port number from 0 to 65535.");

const reports = await Promise.all(
  values.report.map((reference, index) => {
    const separator = reference.indexOf("=");
    if (separator <= 0 || separator === reference.length - 1)
      throw new Error(
        'Use --report "Game name=path/to/report.json" to open a saved report.',
      );
    return loadReport(
      reference.slice(0, separator),
      reference.slice(separator + 1),
      String(index),
    );
  }),
);
const jobs = new DashboardJobs(values.config, path.resolve(values.output));
await jobs.restore();
const runRequest = z.object({
  repositories: z
    .array(
      z.object({
        repository: z.string().min(1),
        branch: z.string().min(1).optional(),
        allowBuildSmoke: z.literal(true).optional(),
      }),
    )
    .min(1),
});
const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/dashboard.css": ["dashboard.css", "text/css; charset=utf-8"],
  "/dashboard.js": ["dashboard.js", "text/javascript; charset=utf-8"],
} as const;

function send(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(data));
}

function serve(response: ServerResponse, filename: string, type: string) {
  const stream = createReadStream(filename);
  stream.once("open", () => {
    response.writeHead(200, { "Content-Type": type });
    stream.pipe(response);
  });
  stream.once("error", () => {
    if (response.headersSent) response.destroy();
    else send(response, 404, { error: "File is unavailable." });
  });
  response.on("close", () => stream.destroy());
}

async function readRunRequest(request: IncomingMessage) {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) return;
  }
  try {
    return runRequest.parse(JSON.parse(body));
  } catch {
    return;
  }
}

const server = createServer(async (request, response) => {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  if (request.headers.host !== `127.0.0.1:${serverPort()}`)
    return send(response, 403, {
      error: "Open the dashboard at its local URL.",
    });
  try {
    await handle(request, response);
  } catch (error) {
    if (response.headersSent) response.destroy();
    else send(response, 502, { error: message(error) });
  }
});

async function handle(request: IncomingMessage, response: ServerResponse) {
  const route = request.url;
  if (route === "/api/runs" && request.method === "POST") {
    if (
      request.headers.origin !== `http://127.0.0.1:${serverPort()}` ||
      request.headers["content-type"] !== "application/json"
    )
      return send(response, 403, {
        error: "Start the run from the local dashboard.",
      });
    const body = await readRunRequest(request);
    if (!body)
      return send(response, 400, { error: "Select one or more repositories." });
    const result = await jobs.start(body.repositories);
    return send(response, result.status, result);
  }
  if (request.method !== "GET")
    return send(response, 405, { error: "Method unavailable." });
  if (route === "/api/repositories")
    return send(response, 200, await jobs.repositories());
  if (route?.startsWith("/api/branches?")) {
    const repo = new URLSearchParams(route.slice("/api/branches?".length)).get(
      "repository",
    );
    if (!repo) return send(response, 400, { error: "Select a repository." });
    return send(response, 200, await jobs.branches(repo));
  }
  if (route === "/api/runs") return send(response, 200, jobs.jobs);
  if (route === "/api/reports")
    return send(
      response,
      200,
      [...reports, ...jobs.reports].map((report) => report.data),
    );
  if (route && Object.hasOwn(assets, route)) {
    const [filename, type] = assets[route as keyof typeof assets];
    return serve(
      response,
      fileURLToPath(new URL(`./dashboard/${filename}`, import.meta.url)),
      type,
    );
  }
  const match = /^\/evidence\/([\da-f-]+)\/(\d+)$/.exec(route ?? "");
  if (match?.[1] !== undefined && match[2] !== undefined) {
    const report = [...reports, ...jobs.reports].find(
      (entry) => entry.data.id === match[1],
    );
    const file = await report?.evidence(match[2]);
    if (file)
      return serve(
        response,
        file.path,
        file.image ? "image/png" : "text/plain; charset=utf-8",
      );
  }
  send(response, 404, { error: "Page or evidence unavailable." });
}

function serverPort() {
  const address = server.address();
  return address && typeof address === "object" ? address.port : port;
}
server.listen(port, "127.0.0.1", () =>
  console.log(`http://127.0.0.1:${serverPort()}/`),
);
