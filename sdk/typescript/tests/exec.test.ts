import * as child_process from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "@jest/globals";

jest.mock("node:child_process", () => {
  const actual = jest.requireActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: jest.fn() };
});

const _actualChildProcess =
  jest.requireActual<typeof import("node:child_process")>("node:child_process");
const spawnMock = child_process.spawn as jest.MockedFunction<typeof _actualChildProcess.spawn>;

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function createEarlyExitChild(exitCode = 2): FakeChildProcess {
  const child = new FakeChildProcess();
  setImmediate(() => {
    child.stderr.write("boom");
    child.emit("exit", exitCode, null);
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
    });
  });
  return child;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("CodexExec", () => {
  it("rejects when exit happens before stdout closes", async () => {
    const { CodexExec } = await import("../src/exec");
    const child = createEarlyExitChild();
    spawnMock.mockReturnValue(child as unknown as child_process.ChildProcess);

    const exec = new CodexExec("codex");
    const runPromise = (async () => {
      for await (const _ of exec.run({ input: "hi" })) {
        // no-op
      }
    })().then(
      () => ({ status: "resolved" as const }),
      (error) => ({ status: "rejected" as const, error }),
    );

    const result = await Promise.race([
      runPromise,
      delay(500).then(() => ({ status: "timeout" as const })),
    ]);

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toMatch(/Codex Exec exited/);
    }
  });

  it("surfaces a truncated event stream instead of yielding a partial record", async () => {
    // Regression for https://github.com/openai/codex/issues/23131: when the codex
    // process is killed mid-write of a large event, stdout ends without a trailing
    // newline. The consumer must NOT yield that partial record (which would make
    // the caller JSON.parse a truncated line and report a confusing "Failed to
    // parse item" that dumps the payload) — it must surface a clear diagnostic.
    const { CodexExec } = await import("../src/exec");
    spawnMock.mockClear();
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child as unknown as child_process.ChildProcess);

    const completeRecord = JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "ok" },
    });
    // A large MCP event cut off mid-string (no trailing newline).
    const partialRecord =
      '{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call",' +
      '"server":"figma","tool":"get_metadata","result":{"content":[{"type":"text",' +
      '"text":"<frame name=\\"쿠폰명 : {쿠폰정보1';

    setImmediate(() => {
      child.stdout.write(completeRecord + "\n");
      child.stdout.write(partialRecord);
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 1, null);
    });

    const exec = new CodexExec("codex");
    const lines: string[] = [];
    const run = (async () => {
      for await (const line of exec.run({ input: "hi" })) {
        lines.push(line);
      }
    })().then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    const result = await Promise.race([
      run,
      delay(500).then(() => ({ status: "timeout" as const })),
    ]);

    // Only the complete, newline-terminated record is yielded; the partial one is
    // withheld and reported as an error.
    expect(lines).toEqual([completeRecord]);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      const error = result.error as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/mid-record|incomplete|unterminated/i);
      // The diagnostic names the failure; it does not dump the truncated payload.
      expect(error.message).not.toContain("쿠폰명");
    }
  });

  it("places resume args before image args", async () => {
    const { CodexExec } = await import("../src/exec");
    spawnMock.mockClear();
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child as unknown as child_process.ChildProcess);

    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
    });

    const exec = new CodexExec("codex");
    for await (const _ of exec.run({ input: "hi", images: ["img.png"], threadId: "thread-id" })) {
      // no-op
    }

    const commandArgs = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(commandArgs).toBeDefined();
    const resumeIndex = commandArgs!.indexOf("resume");
    const imageIndex = commandArgs!.indexOf("--image");
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(imageIndex).toBeGreaterThan(-1);
    expect(resumeIndex).toBeLessThan(imageIndex);
  });

  it("allows overriding the env passed to the Codex CLI", async () => {
    const { CodexExec } = await import("../src/exec");
    spawnMock.mockClear();
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child as unknown as child_process.ChildProcess);

    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
    });

    process.env.CODEX_ENV_SHOULD_NOT_LEAK = "leak";

    try {
      const exec = new CodexExec("codex", {
        CODEX_HOME: "/tmp/codex-home",
        CUSTOM_ENV: "custom",
      });

      for await (const _ of exec.run({
        input: "custom env",
        apiKey: "test",
        baseUrl: "https://example.test",
      })) {
        // no-op
      }

      const commandArgs = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
      expect(commandArgs).toBeDefined();
      const spawnOptions = spawnMock.mock.calls[0]?.[2] as child_process.SpawnOptions | undefined;
      const spawnEnv = spawnOptions?.env as Record<string, string> | undefined;
      expect(spawnEnv).toBeDefined();
      if (!spawnEnv || !commandArgs) {
        throw new Error("Spawn args missing");
      }

      expect(spawnEnv.CODEX_HOME).toBe("/tmp/codex-home");
      expect(spawnEnv.CUSTOM_ENV).toBe("custom");
      expect(spawnEnv.CODEX_ENV_SHOULD_NOT_LEAK).toBeUndefined();
      expect(spawnEnv.CODEX_API_KEY).toBe("test");
      expect(spawnEnv.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBeDefined();
      expect(commandArgs).toContain("--config");
      expect(commandArgs).toContain(`openai_base_url=${JSON.stringify("https://example.test")}`);
    } finally {
      delete process.env.CODEX_ENV_SHOULD_NOT_LEAK;
    }
  });
});
