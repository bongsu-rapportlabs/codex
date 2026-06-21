import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "@jest/globals";

import { ThreadEvent } from "../src/index";

import {
  assistantMessage,
  responseCompleted,
  responseStarted,
  sse,
  startResponsesTestProxy,
  type SseEvent,
} from "./responsesProxy";
import { createTestClient } from "./testCodex";

function execCommandCall(cmd: string): SseEvent {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: "call_cat_1",
      name: "exec_command",
      arguments: JSON.stringify({ cmd }),
    },
  } as unknown as SseEvent;
}

describe("real codex binary: large multiline tool result over the exec JSONL stream", () => {
  // End-to-end check for https://github.com/openai/codex/issues/23131. Drive the
  // actual `codex exec --experimental-json` binary so it runs a command whose
  // output is a large, multi-line, non-ASCII (Figma-shaped) result, and confirm
  // the SDK consumes the resulting `item.completed` WITHOUT a "Failed to parse
  // item" error. This proves the producer emits a large multiline tool result as
  // exactly one valid JSONL line (escaped newlines) — i.e. the original failure
  // is not producer escaping, and a successfully delivered event always parses.
  it("streams a large multiline command result as one valid JSONL event", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "codex-large-tool-"));
    const block = [
      `<frame name="쿠폰명 : {쿠폰정보1 쿠폰명}" x="0" y="0">`,
      `  <text value="\\"인용된\\" 값 & <escaped>" path="C:\\\\Users\\\\design\\\\figma.fig" />`,
    ].join("\n");
    const large = Array.from({ length: 1500 }, () => block).join("\n");
    const dataFile = path.join(home, "figma.txt");
    writeFileSync(dataFile, large);

    const { url, close } = await startResponsesTestProxy({
      statusCode: 200,
      responseBodies: [
        sse(responseStarted("r1"), execCommandCall(`cat ${dataFile}`), responseCompleted("r1")),
        sse(responseStarted("r2"), assistantMessage("done"), responseCompleted("r2")),
      ],
    });

    const { client, cleanup } = createTestClient({ baseUrl: url });

    try {
      const thread = client.startThread({
        skipGitRepoCheck: true,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      });

      const events: ThreadEvent[] = [];
      let streamError: unknown;
      try {
        const result = await thread.runStreamed("Run the cat command on the figma file.");
        for await (const event of result.events) {
          events.push(event);
        }
      } catch (error) {
        streamError = error;
      }

      // The crux: the large multiline result is delivered as a parseable event,
      // never a "Failed to parse item".
      expect(streamError).toBeUndefined();

      const completed = events.find(
        (event): event is Extract<ThreadEvent, { type: "item.completed" }> =>
          event.type === "item.completed" && event.item.type === "command_execution",
      );
      expect(completed).toBeDefined();

      const item = completed!.item;
      if (item.type !== "command_execution") throw new Error("expected command_execution");
      // The large, multi-line, non-ASCII output round-trips intact through the
      // real exec JSONL stream — newlines survived as escaped string data.
      expect(item.aggregated_output.length).toBeGreaterThan(50_000);
      expect(item.aggregated_output).toContain("\n");
      expect(item.aggregated_output).toContain("쿠폰명");
    } finally {
      cleanup();
      await close();
    }
  }, 60_000);
});
