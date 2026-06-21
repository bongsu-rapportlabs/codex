import * as child_process from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "@jest/globals";

import type { ThreadEvent } from "../src/index";

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

// Golden record emitted by the Rust producer (`codex exec --experimental-json`)
// for a Figma-shaped multiline MCP `item.completed` event. It is generated and
// kept in sync by the Rust test
// `codex-exec multiline_mcp_result_matches_sdk_contract_fixture` — both sides
// share this one artifact, so a producer schema change forces this fixture (and
// thus the consumer contract) to be regenerated.
const CONTRACT_FIXTURE = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "mcp-multiline-item-completed.jsonl",
);

describe("TypeScript SDK JSONL consumer contract", () => {
  // Contract: the producer emits each event as a single valid JSONL record with
  // newlines inside strings escaped as `\n`. The SDK consumer must parse that
  // record as-is, with no line-reassembly hack, even when an `item.completed` MCP
  // tool result is multi-line. Regression for
  // https://github.com/openai/codex/issues/23131.
  it("consumes the producer's multiline MCP record without reassembly", async () => {
    const { Codex } = await import("../src/codex");

    spawnMock.mockClear();
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child as unknown as child_process.ChildProcess);

    const mcpRecord = readFileSync(CONTRACT_FIXTURE, "utf8").replace(/\n$/, "");

    // Producer-side guarantee the consumer relies on: the record is a single
    // line whose embedded newlines are escaped, never raw newlines that would
    // split the JSONL stream.
    expect(mcpRecord.includes("\n")).toBe(false);
    expect(mcpRecord.includes("\\n")).toBe(true);

    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
      JSON.stringify({ type: "turn.started" }),
      mcpRecord,
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      }),
    ];

    setImmediate(() => {
      child.stdout.write(lines.join("\n") + "\n");
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
    });

    const client = new Codex({ codexPathOverride: "codex" });
    const thread = client.startThread();

    const events: ThreadEvent[] = [];
    const result = await thread.runStreamed("read figma metadata");
    for await (const event of result.events) {
      events.push(event);
    }

    const completed = events.filter((event) => event.type === "item.completed");
    expect(completed).toHaveLength(1);

    const item = (completed[0] as Extract<ThreadEvent, { type: "item.completed" }>).item;
    expect(item.type).toBe("mcp_tool_call");
    if (item.type !== "mcp_tool_call") {
      throw new Error("expected mcp_tool_call item");
    }

    // The multi-line text round-trips intact: escaped newlines decode back to
    // real newlines in string data, never treated as a JSONL record boundary.
    const text = (item.result?.content[0] as { text?: string } | undefined)?.text;
    expect(typeof text).toBe("string");
    expect(text).toContain("\n");
    expect(text).toContain("쿠폰명");
  });
});
