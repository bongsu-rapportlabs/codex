import * as child_process from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "@jest/globals";

import { Codex } from "../src/codex";

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

describe("Codex run exec failure handling", () => {
  it("passes through a complete large MCP item", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child as unknown as child_process.ChildProcess);
    const item = createLargeMcpItem();

    setImmediate(() => {
      child.stdout.write('{"type":"thread.started","thread_id":"thread-1"}\n');
      child.stdout.write(`${item}\n`);
      child.emit("exit", 0, null);
      setImmediate(() => {
        child.stdout.end();
        child.stderr.end();
      });
    });

    const client = new Codex({ codexPathOverride: "codex", env: {} });
    const thread = client.startThread();

    const result = await thread.run("read a large MCP result");

    expect(thread.id).toBe("thread-1");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "item_7",
      type: "mcp_tool_call",
      server: "example",
      tool: "large_result",
    });
  });

  it("reports exec failure instead of parsing a large partial MCP item", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child as unknown as child_process.ChildProcess);

    setImmediate(() => {
      child.stdout.write('{"type":"thread.started","thread_id":"thread-1"}\n');
      child.stdout.write(createPartialLargeMcpItem());
      child.stderr.write("core process failed while writing jsonl");
      child.emit("exit", 2, null);
      setImmediate(() => {
        child.stdout.end();
        child.stderr.end();
      });
    });

    const client = new Codex({ codexPathOverride: "codex", env: {} });
    const thread = client.startThread();

    let error: Error | undefined;
    try {
      await thread.run("read a large MCP result");
    } catch (err) {
      error = err as Error;
    }

    expect(thread.id).toBe("thread-1");
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/Codex Exec exited with code 2/);
    expect(error?.message).toMatch(/Partial stdout: \{"type":"item.completed"/);
    expect(error?.message).not.toMatch(/Failed to parse item/);
  });
});

function createPartialLargeMcpItem(): string {
  return createLargeMcpItem().slice(0, -32);
}

function createLargeMcpItem(): string {
  const largeSheetLikeText = Array.from(
    { length: 200 },
    (_, row) => `row ${row}: ${"cell value ".repeat(24)}`,
  ).join("\n");

  const item = JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_7",
      type: "mcp_tool_call",
      server: "example",
      tool: "large_result",
      arguments: "{}",
      result: {
        content: [{ type: "text", text: largeSheetLikeText }],
        isError: false,
      },
    },
  });

  return item;
}
