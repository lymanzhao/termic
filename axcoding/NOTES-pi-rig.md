# pi + rig research notes (verified 2026-09-23)

## pi (earendil-works/pi, fka badlogic/pi-mono)

Mario Zechner sold pi to Earendil (Armin Ronacher's shop) 2026-04-08; core
stays MIT. Philosophy, his words: "if I don't need it, it won't be built";
"No harness allows [inspecting every aspect of my interactions]"; the
system prompt + tool defs come in "below 1000 tokens"; "pi runs in full
YOLO mode"; "pi does not and will not support MCP" (his MCP post: four
~225-token scripts beat a 13.7k-token MCP server; "Bash and code are
composable").

Loop skeleton (agent-loop.ts): append user msg; stream; if error/abort
stop; execute tool calls; append results; repeat while tool calls; then
drain follow-up queue. No max-steps knob anywhere. Sessions are JSONL
trees (id + parent per entry; branches are paths). Default tools exactly
four: read, write, edit, bash.

The "append-only transcript / no hidden state / user-owned loop" triad is
a community paraphrase - NOT his verbatim words. His verbatim version:
"The only state you manage is what you can observe and modify: your
messages and the LLM's responses." Treat the triad as a summary, not a
quotation.

## rig-core 0.42.0 (2026-08-17)

Since 0.41 the crate split: rig-core = providers + model + message + tool
contracts; rig-agent = Agent/AgentBuilder/runner; `rig` = facade re-export.
Crate/lib name is `rig_core` (underscore). MSRV undeclared but edition
2024 => rustc >= 1.85. Default features ["reqwest", "derive", "rustls"].

What axcoding uses (all verified in the registry source, not docs):
- `providers::anthropic::{Client, completion::CLAUDE_SONNET_4_6}`,
  `providers::openai::{Client, completion::GPT_5_6}`.
- `<Client as ProviderClient>::from_env()` - NOTE: bare
  `Client::from_env()` failed method resolution even with the trait in
  scope; the fully qualified form works. Same for openai.
- `client.completion_model(name)` (trait `CompletionClient`).
- `CompletionRequestBuilder`: `.preamble(String)` + `.messages(EXTENDS,
  not replaces)` + `.tools(Vec<ToolDefinition>)` + `.build()`;
  `build()` => `[System(preamble)] + history + [prompt]`, so pass the
  opening user message as the request prompt and the rest as history.
- `Message::user/assistant/system(text)`, `Message::tool_result(call_id,
  name, content)` (User msg carrying a ToolResult part),
  `AssistantContent::text(..)` / `::tool_call(id, name, args_json_value)`.
- `CompletionResponse { choice: Vec<AssistantContent>, .. }` - filter
  Text / ToolCall parts; ToolCall.id has `.as_str()`.
- Hand-written multi-turn loop is ~30 lines; rig-agent's runner (Agent,
  max_turns semantics changed in 0.40 to an exact total-call budget that
  ERRORS via PromptError::MaxTurnsError when exceeded) was not needed.

`Tool` trait (rig-agent) changed a lot in 0.40-0.42: `const NAME`, no
`definition()`, `call(&mut ToolContext, typed Args)`; rig-core has the
context-free `PortableTool` twin with a blanket `impl Tool for T`. The
`#[rig_tool]` derive is on by default. axcoding uses none of this: our
tools are plain dispatch functions because we own the loop.
