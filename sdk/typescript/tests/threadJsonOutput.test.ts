import { describe, expect, it } from "@jest/globals";

import { Thread, ThreadEvent } from "../src/index";

describe("Thread JSON output parsing", () => {
  it("reassembles JSON events split by an unescaped newline inside a string", async () => {
    const exec = {
      async *run() {
        yield '{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"figma","tool":"get_metadata","arguments":{},"result":{"content":[{"type":"text","text":"<text name=\\"Line one';
        yield 'Line two\\" />"}],"structured_content":null},"status":"completed"}}';
      },
    };
    const thread = new Thread(exec as never, {}, {});

    const streamed = await thread.runStreamed("inspect figma");
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
                text: '<text name="Line one\nLine two" />',
              },
            ],
          }),
          server: "figma",
          tool: "get_metadata",
          type: "mcp_tool_call",
        }),
      },
    ]);
  });
});
