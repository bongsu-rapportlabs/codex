import { describe, expect, it } from "@jest/globals";

import { Thread, ThreadEvent } from "../src/index";

describe("Thread JSON output parsing", () => {
  it("reassembles JSON events split by an unescaped newline inside a string", async () => {
    const exec = {
      async *run() {
        yield '{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"example","tool":"large_result","arguments":{},"result":{"content":[{"type":"text","text":"first line';
        yield 'second line"}],"structured_content":null},"status":"completed"}}';
      },
    };
    const thread = new Thread(exec as never, {}, {});

    const streamed = await thread.runStreamed("read a large MCP result");
    const events: ThreadEvent[] = [];
    for await (const event of streamed.events) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "item.completed",
        item: expect.objectContaining({
          id: "item_0",
          result: expect.objectContaining({
            content: [
              {
                type: "text",
                text: "first line\nsecond line",
              },
            ],
          }),
          server: "example",
          tool: "large_result",
          type: "mcp_tool_call",
        }),
      },
    ]);
  });

  it("fails instead of buffering an unterminated JSON string without bound", async () => {
    const oversizedText = "x".repeat(33 * 1024 * 1024);
    const exec = {
      async *run() {
        yield `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"${oversizedText}`;
      },
    };
    const thread = new Thread(exec as never, {}, {});

    const streamed = await thread.runStreamed("read a large MCP result");
    await expect(
      (async () => {
        for await (const event of streamed.events) {
          expect(event).toBeDefined();
        }
      })(),
    ).rejects.toThrow("pending JSON event exceeded");
  });
});
