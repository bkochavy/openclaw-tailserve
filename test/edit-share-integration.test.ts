import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { createEditShare } from "../src/shares.js";
import { createTailserveServer } from "../src/server.js";
import { readState } from "../src/state.js";

const originalHome = process.env.HOME;

interface ServerResponsePayload {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

class MockWritableResponse extends Writable {
  public headersSent = false;
  public statusCode = 200;
  public readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];
  private settled = false;
  private readonly onSettle: (payload: ServerResponsePayload) => void;

  constructor(onSettle: (payload: ServerResponsePayload) => void) {
    super();
    this.onSettle = onSettle;
    this.on("finish", () => {
      this.settle();
    });
    this.on("close", () => {
      this.settle();
    });
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  setHeader(name: string, value: number | string | string[]): void {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  override end(chunk?: string | Buffer): this {
    this.headersSent = true;
    return chunk === undefined ? super.end() : super.end(chunk);
  }

  override destroy(error?: Error): this {
    this.headersSent = true;
    return super.destroy(error);
  }

  private settle(): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.onSettle({
      statusCode: this.statusCode,
      headers: this.headers,
      body: Buffer.concat(this.chunks).toString("utf8"),
    });
  }
}

async function dispatchServerRequest(
  server: ReturnType<typeof createTailserveServer>,
  options: {
    method: string;
    url: string;
    body?: string;
  },
): Promise<ServerResponsePayload> {
  return await new Promise((resolve) => {
    const request = new EventEmitter() as EventEmitter & {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
      setEncoding?: (encoding: BufferEncoding) => void;
    };

    request.method = options.method;
    request.url = options.url;
    request.headers = {};
    request.setEncoding = () => {
      return;
    };

    const response = new MockWritableResponse(resolve);
    server.emit("request", request as never, response as never);

    if (typeof options.body === "string") {
      request.emit("data", options.body);
    }

    request.emit("end");
  });
}

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
    return;
  }

  process.env.HOME = originalHome;
});

describe("edit share integration", () => {
  it("creates an edit share for a temp file and persists type=edit in state", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "notes.md");
    writeFileSync(filePath, "# hello\n", "utf8");

    const { id } = createEditShare(filePath);
    const state = readState();

    expect(state.shares[id]).toBeDefined();
    expect(state.shares[id].type).toBe("edit");
    expect(state.shares[id].path).toBe(path.resolve(filePath));
  });

  it("serves edit content via GET and writes updates via POST /api/save", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "notes.md");
    writeFileSync(filePath, "# before\n", "utf8");

    const { id } = createEditShare(filePath);
    const server = createTailserveServer();

    try {
      const contentResponse = await dispatchServerRequest(server, {
        method: "GET",
        url: `/s/${id}/api/content`,
      });

      expect(contentResponse.statusCode).toBe(200);
      expect(contentResponse.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(contentResponse.body).toBe("# before\n");

      const saveResponse = await dispatchServerRequest(server, {
        method: "POST",
        url: `/s/${id}/api/save`,
        body: "# after\n",
      });

      expect(saveResponse.statusCode).toBe(200);
      expect(saveResponse.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(saveResponse.body).toBe(JSON.stringify({ ok: true }));
      expect(readFileSync(filePath, "utf8")).toBe("# after\n");
    } finally {
      server.emit("close");
    }
  });

  it("returns 403 on readonly save requests and leaves file unchanged", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "notes.md");
    writeFileSync(filePath, "# readonly\n", "utf8");

    const { id } = createEditShare(filePath, { readonly: true });
    const server = createTailserveServer();

    try {
      const response = await dispatchServerRequest(server, {
        method: "POST",
        url: `/s/${id}/api/save`,
        body: "# blocked\n",
      });

      expect(response.statusCode).toBe(403);
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(response.body).toBe(JSON.stringify({ ok: false, error: "readonly" }));
      expect(readFileSync(filePath, "utf8")).toBe("# readonly\n");
    } finally {
      server.emit("close");
    }
  });

  it("serves editor HTML for markdown and code edit shares", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const markdownPath = path.join(workspace, "notes.md");
    const codePath = path.join(workspace, "app.ts");
    writeFileSync(markdownPath, "# markdown\n", "utf8");
    writeFileSync(codePath, "export const value = 1;\n", "utf8");

    const markdownShare = createEditShare(markdownPath);
    const codeShare = createEditShare(codePath);
    const server = createTailserveServer();

    try {
      const markdownResponse = await dispatchServerRequest(server, {
        method: "GET",
        url: `/s/${markdownShare.id}`,
      });

      expect(markdownResponse.statusCode).toBe(200);
      expect(markdownResponse.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(markdownResponse.body).toContain("@tiptap/core");

      const codeResponse = await dispatchServerRequest(server, {
        method: "GET",
        url: `/s/${codeShare.id}`,
      });

      expect(codeResponse.statusCode).toBe(200);
      expect(codeResponse.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(codeResponse.body).toContain("@codemirror/state");
    } finally {
      server.emit("close");
    }
  });
});
