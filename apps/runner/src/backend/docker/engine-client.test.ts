import { describe, expect, it } from "vitest";
import {
  DockerEngine,
  DockerEngineError,
  encodeFilters,
  splitImageRef,
  type EngineTransport,
} from "./engine-client";
import { buildTar } from "./tar";

/** The wire details that are easy to get subtly wrong and hard to see fail. */

const responder = (
  handler: (options: { method: string; path: string }) => {
    statusCode: number;
    payload?: unknown;
    text?: string;
  },
): EngineTransport => ({
  async request(options) {
    const result = handler(options);
    const text = result.text ?? JSON.stringify(result.payload ?? {});
    return {
      statusCode: result.statusCode,
      body: {
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
        dump: async () => {},
      },
    };
  },
  close: async () => {},
});

describe("version negotiation", () => {
  it("keeps our target when the daemon is newer", async () => {
    const engine = new DockerEngine(
      responder(() => ({
        statusCode: 200,
        payload: { ApiVersion: "1.55", MinAPIVersion: "1.24" },
      })),
    );
    expect(await engine.negotiateVersion()).toBe("1.44");
  });

  it("clamps down when the daemon is older", async () => {
    const engine = new DockerEngine(
      responder(() => ({
        statusCode: 200,
        payload: { ApiVersion: "1.41", MinAPIVersion: "1.24" },
      })),
    );
    expect(await engine.negotiateVersion()).toBe("1.41");
  });

  it("compares versions numerically, not as strings (1.9 < 1.44)", async () => {
    const engine = new DockerEngine(
      responder(() => ({
        statusCode: 200,
        payload: { ApiVersion: "1.9", MinAPIVersion: "1.9" },
      })),
    );
    expect(await engine.negotiateVersion()).toBe("1.9");
  });

  it("refuses a daemon too new to speak our version", async () => {
    const engine = new DockerEngine(
      responder(() => ({
        statusCode: 200,
        payload: { ApiVersion: "2.0", MinAPIVersion: "1.50" },
      })),
    );
    await expect(engine.negotiateVersion()).rejects.toBeInstanceOf(
      DockerEngineError,
    );
  });
});

describe("status handling", () => {
  it("tolerates 304 (already started / already stopped)", async () => {
    const engine = new DockerEngine(
      responder(({ path }) =>
        path.endsWith("/version")
          ? { statusCode: 200, payload: { ApiVersion: "1.44" } }
          : { statusCode: 304, text: "" },
      ),
    );
    await engine.negotiateVersion();
    await expect(
      engine.post("/containers/c/start", undefined, { tolerate: [304] }),
    ).resolves.toBeNull();
  });

  it("throws with the status and detail on a real failure", async () => {
    const engine = new DockerEngine(
      responder(({ path }) =>
        path.endsWith("/version")
          ? { statusCode: 200, payload: { ApiVersion: "1.44" } }
          : { statusCode: 409, text: '{"message":"container is running"}' },
      ),
    );
    await engine.negotiateVersion();

    await expect(engine.delete("/containers/c")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("returns null for a 204 rather than trying to parse it", async () => {
    const engine = new DockerEngine(
      responder(({ path }) =>
        path.endsWith("/version")
          ? { statusCode: 200, payload: { ApiVersion: "1.44" } }
          : { statusCode: 204, text: "" },
      ),
    );
    await engine.negotiateVersion();
    expect(await engine.post("/anything")).toBeNull();
  });
});

describe("image pulls", () => {
  it("splits the tag on the last colon AFTER the last slash", () => {
    // `fromImage` without `tag` pulls EVERY tag of the repository — the
    // split is a correctness requirement, not tidiness.
    expect(splitImageRef("onecli-agent:dev")).toEqual({
      fromImage: "onecli-agent",
      tag: "dev",
    });
    expect(splitImageRef("ghcr.io:443/onecli/agent:v2")).toEqual({
      fromImage: "ghcr.io:443/onecli/agent",
      tag: "v2",
    });
    // Untagged pins latest — never the whole repo.
    expect(splitImageRef("ghcr.io/onecli/onecli-agent")).toEqual({
      fromImage: "ghcr.io/onecli/onecli-agent",
      tag: "latest",
    });
    // A digest already names one image; it passes whole.
    expect(splitImageRef("onecli-agent@sha256:abc123")).toEqual({
      fromImage: "onecli-agent@sha256:abc123",
    });
  });

  it("drains the NDJSON stream and succeeds on a clean pull", async () => {
    const paths: string[] = [];
    const engine = new DockerEngine(
      responder(({ path }) => {
        paths.push(path);
        return {
          statusCode: 200,
          text: '{"status":"Pulling"}\n{"status":"Downloading"}\n{"status":"Pull complete"}\n',
        };
      }),
    );

    await engine.pullImage("onecli-agent:dev");
    expect(paths[0]).toBe(
      "/v1.44/images/create?fromImage=onecli-agent&tag=dev",
    );
  });

  it("surfaces a MID-STREAM error line — a failed pull still answers 200", async () => {
    const engine = new DockerEngine(
      responder(() => ({
        statusCode: 200,
        text: '{"status":"Pulling"}\n{"errorDetail":{"message":"manifest unknown"},"error":"manifest for onecli-agent:nope not found"}\n',
      })),
    );

    await expect(engine.pullImage("onecli-agent:nope")).rejects.toThrow(
      /manifest for onecli-agent:nope not found/,
    );
  });

  it("passes the long inter-chunk bodyTimeout through, per request", async () => {
    // The client-level default is 120s; a cold multi-GB pull streams for
    // longer, so the override must actually reach the transport.
    const seen: Array<number | undefined> = [];
    const transport: EngineTransport = {
      async request(options) {
        seen.push(options.bodyTimeout);
        return {
          statusCode: 200,
          body: {
            text: async () => "{}",
            json: async () => ({}),
            dump: async () => {},
          },
        };
      },
      close: async () => {},
    };
    const engine = new DockerEngine(transport);

    await engine.pullImage("onecli-agent:dev");
    expect(seen[0]).toBe(300_000);
  });
});

describe("filters encoding", () => {
  it("encodes a label filter as docker's JSON map of arrays", () => {
    expect(encodeFilters({ label: ["a=1", "b=2"] })).toBe(
      encodeURIComponent('{"label":["a=1","b=2"]}'),
    );
  });
});

describe("tar builder", () => {
  const parse = (archive: Buffer) => {
    const name = archive.subarray(0, 100).toString("utf8").replace(/\0+$/, "");
    const mode = parseInt(
      archive.subarray(100, 107).toString("ascii").replace(/\0+$/, ""),
      8,
    );
    const size = parseInt(
      archive.subarray(124, 135).toString("ascii").replace(/\0+$/, ""),
      8,
    );
    const content = archive.subarray(512, 512 + size).toString("utf8");
    return {
      name,
      mode,
      size,
      content,
      magic: archive.subarray(257, 262).toString("ascii"),
    };
  };

  it("writes a readable USTAR header and body", () => {
    const archive = buildTar([
      { path: "ca.pem", content: "CERT", mode: 0o644 },
    ]);
    const entry = parse(archive);

    expect(entry).toMatchObject({
      name: "ca.pem",
      mode: 0o644,
      size: 4,
      content: "CERT",
      magic: "ustar",
    });
  });

  it("preserves a restrictive mode for credential-shaped files", () => {
    const archive = buildTar([
      { path: "auth.json", content: "{}", mode: 0o600 },
    ]);
    expect(parse(archive).mode).toBe(0o600);
  });

  it("has a valid checksum (docker rejects archives otherwise)", () => {
    const archive = buildTar([{ path: "f", content: "x", mode: 0o644 }]);
    const stored = parseInt(
      archive.subarray(148, 155).toString("ascii").replace(/\0+$/, ""),
      8,
    );

    const recomputed = Buffer.from(archive.subarray(0, 512));
    recomputed.write("        ", 148, 8, "ascii");
    let sum = 0;
    for (const byte of recomputed) sum += byte;

    expect(stored).toBe(sum);
  });

  it("pads every entry to a 512-byte boundary and terminates the archive", () => {
    const archive = buildTar([
      { path: "a", content: "1", mode: 0o644 },
      { path: "b", content: "2", mode: 0o644 },
    ]);
    // 2 × (header + padded body) + 2 terminator blocks
    expect(archive.length).toBe(512 * 6);
    expect(archive.subarray(-1024).every((byte) => byte === 0)).toBe(true);
  });

  it("is byte-stable for the same input (so payload hashes are stable)", () => {
    const once = buildTar([{ path: "f", content: "same", mode: 0o644 }]);
    const twice = buildTar([{ path: "f", content: "same", mode: 0o644 }]);
    expect(once.equals(twice)).toBe(true);
  });
});
