use super::*;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::tempdir;

#[test]
fn failed_turn_does_not_overwrite_output_last_message_file() {
    let tempdir = tempdir().expect("create tempdir");
    let output_path = tempdir.path().join("last-message.txt");
    std::fs::write(&output_path, "keep existing contents").expect("seed output file");

    let mut processor = EventProcessorWithJsonOutput::new(Some(output_path.clone()));

    let collected = processor.collect_thread_events(ServerNotification::ItemCompleted(
        codex_app_server_protocol::ItemCompletedNotification {
            item: ThreadItem::AgentMessage {
                id: "msg-1".to_string(),
                text: "partial answer".to_string(),
                phase: None,
                memory_citation: None,
            },
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            completed_at_ms: 0,
        },
    ));

    assert_eq!(collected.status, CodexStatus::Running);
    assert_eq!(processor.final_message(), Some("partial answer"));

    let status = processor.process_server_notification(ServerNotification::TurnCompleted(
        codex_app_server_protocol::TurnCompletedNotification {
            thread_id: "thread-1".to_string(),
            turn: codex_app_server_protocol::Turn {
                id: "turn-1".to_string(),
                items_view: codex_app_server_protocol::TurnItemsView::Full,
                items: Vec::new(),
                status: TurnStatus::Failed,
                error: Some(codex_app_server_protocol::TurnError {
                    message: "turn failed".to_string(),
                    additional_details: None,
                    codex_error_info: None,
                }),
                started_at: None,
                completed_at: Some(0),
                duration_ms: None,
            },
        },
    ));

    assert_eq!(status, CodexStatus::InitiateShutdown);
    assert_eq!(processor.final_message(), None);

    EventProcessor::print_final_output(&mut processor);

    assert_eq!(
        std::fs::read_to_string(&output_path).expect("read output file"),
        "keep existing contents"
    );
}

#[test]
fn mcp_tool_call_result_preserves_meta_in_jsonl_event() {
    let mut processor = EventProcessorWithJsonOutput::new(/*last_message_path*/ None);

    let collected = processor.collect_thread_events(ServerNotification::ItemCompleted(
        codex_app_server_protocol::ItemCompletedNotification {
            item: ThreadItem::McpToolCall {
                id: "mcp-1".to_string(),
                server: "search service".to_string(),
                tool: "web_run".to_string(),
                status: McpToolCallStatus::Completed,
                arguments: json!({"search_query": [{"q": "OpenAI Codex CLI documentation"}]}),
                mcp_app_resource_uri: None,
                result: Some(Box::new(codex_app_server_protocol::McpToolCallResult {
                    content: vec![json!({"type": "text", "text": "search result"})],
                    structured_content: None,
                    meta: Some(json!({"raw_messages": [{"ref_id": "turn0search0"}]})),
                })),
                error: None,
                duration_ms: Some(42),
            },
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            completed_at_ms: 0,
        },
    ));

    assert_eq!(collected.status, CodexStatus::Running);
    assert_eq!(collected.events.len(), 1);

    let ThreadEvent::ItemCompleted(ItemCompletedEvent { item }) = &collected.events[0] else {
        panic!("expected item.completed event");
    };
    let ThreadItemDetails::McpToolCall(item) = &item.details else {
        panic!("expected MCP tool call item");
    };
    let result = item.result.as_ref().expect("expected MCP tool result");
    assert_eq!(
        result.meta,
        Some(json!({"raw_messages": [{"ref_id": "turn0search0"}]}))
    );

    let serialized = serde_json::to_value(&collected.events[0]).expect("serialize event");
    assert_eq!(
        serialized["item"]["result"]["_meta"],
        json!({"raw_messages": [{"ref_id": "turn0search0"}]})
    );
    assert!(serialized["item"]["result"].get("meta").is_none());
}

#[test]
fn multiline_mcp_result_matches_sdk_contract_fixture() {
    // A Figma-shaped MCP result like the one in
    // https://github.com/openai/codex/issues/23131: XML-like markup, non-ASCII
    // (Korean) labels, quotes, backslashes, and embedded newlines. Kept under the
    // event byte cap so it passes through unchanged — this is the exact wire shape
    // the TypeScript SDK consumes for a typical MCP result.
    let block = concat!(
        "<frame name=\"쿠폰명 : {쿠폰정보1 쿠폰명}\" x=\"0\" y=\"0\" width=\"0\" height=\"0\">\n",
        "  <text value=\"\\\"인용된\\\" 값 & <escaped>\" path=\"C:\\\\Users\\\\design\\\\figma.fig\" />\n",
        "  <node id=\"1173:53\" label=\"버튼 / primary\" />\n",
        "</frame>\n",
    );
    let multiline_result = block.repeat(8);

    let mut processor = EventProcessorWithJsonOutput::new(/*last_message_path*/ None);
    let collected = processor.collect_thread_events(ServerNotification::ItemCompleted(
        codex_app_server_protocol::ItemCompletedNotification {
            item: ThreadItem::McpToolCall {
                id: "item_3".to_string(),
                server: "figma".to_string(),
                tool: "get_metadata".to_string(),
                status: McpToolCallStatus::Completed,
                arguments: json!({"fileKey": "", "nodeId": "1173:53"}),
                mcp_app_resource_uri: None,
                result: Some(Box::new(codex_app_server_protocol::McpToolCallResult {
                    content: vec![json!({
                        "type": "text",
                        "text": multiline_result,
                    })],
                    structured_content: None,
                    meta: None,
                })),
                error: None,
                duration_ms: Some(42),
            },
            thread_id: "thread_1".to_string(),
            turn_id: "turn_1".to_string(),
            completed_at_ms: 0,
        },
    ));

    assert_eq!(collected.status, CodexStatus::Running);
    assert_eq!(collected.events.len(), 1);

    let record =
        serde_json::to_string(&collected.events[0]).expect("event should serialize as JSON");

    // One valid JSONL record: no raw newline escapes the string, and the
    // multiline payload is preserved as escaped `\n` data.
    assert_eq!(
        record.lines().count(),
        1,
        "JSONL event must not contain raw newlines"
    );
    assert!(record.contains("\\n"));
    let parsed: serde_json::Value =
        serde_json::from_str(&record).expect("JSONL record should parse");
    let text = parsed["item"]["result"]["content"][0]["text"]
        .as_str()
        .expect("result text should be a string");
    assert_eq!(
        text, multiline_result,
        "an under-cap result round-trips unchanged"
    );
    assert!(text.contains('\n'));
    assert!(text.contains("쿠폰명"));

    // Shared producer<->consumer contract fixture: the TypeScript SDK consumer
    // test parses these exact bytes. Keeping it as committed golden output means a
    // change to the producer's event schema breaks this test, signalling that the
    // SDK contract test fixture must be regenerated. Regenerate with:
    //   UPDATE_GOLDEN=1 cargo test -p codex-exec multiline_mcp_result_matches_sdk_contract_fixture
    //
    // Compared as JSON values, not raw bytes: serde_json's `preserve_order`
    // feature is enabled by some workspace crates but not others, so object key
    // ordering is build-graph dependent. The SDK consumer (`JSON.parse`) is
    // order-independent too, so the byte-level guarantees it actually relies on
    // (single line, escaped newlines) are asserted above on `record` directly.
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../sdk/typescript/tests/fixtures/mcp-multiline-item-completed.jsonl");
    let golden = format!("{record}\n");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(&fixture, &golden).expect("write SDK contract fixture");
    }
    let committed = std::fs::read_to_string(&fixture).unwrap_or_else(|err| {
        panic!(
            "missing SDK contract fixture {}: {err}; regenerate with UPDATE_GOLDEN=1",
            fixture.display()
        )
    });
    // The committed fixture must itself be one escaped JSONL line.
    assert_eq!(
        committed.trim_end_matches('\n').lines().count(),
        1,
        "committed contract fixture must be a single JSONL line"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(committed.trim_end()).expect("fixture is JSON"),
        serde_json::from_str::<serde_json::Value>(&record).expect("record is JSON"),
        "producer record drifted from the committed SDK contract fixture; regenerate with UPDATE_GOLDEN=1"
    );
}
