# `@luutuankiet/gemini-mcp`

**Drop-in MCP proxy that makes any MCP server work with Gemini.**

Gemini implements a [strict subset of JSON Schema](https://ai.google.dev/gemini-api/docs/function-calling#function_declarations) (OpenAPI 3.0-flavored). When MCP servers use common JSON Schema patterns — `$ref`, `$defs`, `anyOf`, `additionalProperties`, `title`, `default` — Gemini either silently degrades parameters to `STRING` or returns hard `400` errors.

This proxy sits between your MCP client and any MCP server, transparently transforming tool schemas so Gemini can call them correctly.

## The Problem

```
✕ Error discovering tools from awslabs.aws-api-mcp-server:
  can't resolve reference #/$defs/ProgramInterpretationResponse from id #
```

```
400 Bad Request: reference to undefined schema at properties.target_object.anyOf.1
```

These failures affect **every Pydantic-based MCP server** (AWS, Snowflake, etc.) and many TypeScript servers (Notion, etc.). The root cause: Gemini's API doesn't support standard JSON Schema features that MCP servers use heavily.

| Pattern | What Happens in Gemini | Affected Servers |
|---------|----------------------|------------------|
| `$ref` / `$defs` | Hard 400 error — "can't resolve reference" | All Python/Pydantic MCP servers |
| `anyOf[T, null]` | Hard 400 — "undefined schema" | Pydantic `Optional[T]` fields |
| `anyOf` with `$ref` inside | Double failure — unresolved ref + union | Snowflake, AWS |
| `title`, `default` | Silent degradation or rejected | All Pydantic servers |
| `additionalProperties` | Schema validation conflict | Notion, complex TS servers |
| `allOf` / `oneOf` | Not supported in Gemini Schema | Servers using composition |

**References:**
- [gemini-cli #13270](https://github.com/google-gemini/gemini-cli/issues/13270) — aws-api-mcp-server `$defs` failure
- [gemini-cli #13326](https://github.com/google-gemini/gemini-cli/issues/13326) — Snowflake `$ref` inside `anyOf`
- [awslabs/mcp #2442](https://github.com/awslabs/mcp/issues/2442) — cost-explorer nested model failure
- [gemini-cli #11020](https://github.com/google-gemini/gemini-cli/issues/11020) — Notion `additionalProperties` composition bug

## How It Works

`gemini-mcp` wraps any MCP server (stdio, SSE, or HTTP) and intercepts `tools/list` responses. Before returning tool schemas to the client, it applies a 7-phase transformation pipeline:

```
MCP Client ←→ gemini-mcp ←→ Any MCP Server
                  ↕
         Schema Transform
         (tools/list only)
```

| Phase | Transform | Why |
|-------|-----------|-----|
| 1 | Dereference `$ref` → inline definitions | Gemini can't resolve `$ref`, degrades to STRING |
| 2 | Remove `$defs` / `definitions` | Cleanup after Phase 1 |
| 3 | `anyOf[T, null]` → `{type: T, nullable: true}` | Gemini doesn't understand null unions |
| 3b | `oneOf` → `anyOf`, `allOf` → merge | Gemini only supports `anyOf` |
| 4 | `const` → `enum` | Not in Gemini Schema spec |
| 5 | `exclusiveMinimum/Maximum` → `minimum/maximum` | Not in Gemini Schema spec |
| 6 | Strip forbidden keys (`title`, `default`, `additionalProperties`, etc.) | Cause silent degradation or 400s |
| 7 | Remove `if`/`then`/`else` conditionals | Not supported |

All transforms are **lossless for tool calling** — they only affect schema metadata, not the actual parameter values passed to tools.

## Quick Start

### With Claude Desktop / Cursor / Windsurf

Replace `mcp-remote` (or any stdio-based wrapper) with `gemini-mcp`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": [
        "@luutuankiet/gemini-mcp",
        "https://remote.mcp.server/sse"
      ]
    }
  }
}
```

### With a local stdio server

Wrap any existing stdio MCP server:

```json
{
  "mcpServers": {
    "aws-api": {
      "command": "npx",
      "args": [
        "@luutuankiet/gemini-mcp",
        "uvx",
        "awslabs.aws-api-mcp-server@latest"
      ],
      "env": {
        "AWS_REGION": "us-east-1"
      }
    }
  }
}
```

### Gemini CLI

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": [
        "@luutuankiet/gemini-mcp",
        "npx",
        "@notionhq/notion-mcp-server"
      ],
      "env": {
        "NOTION_API_TOKEN": "..."
      }
    }
  }
}
```

## CLI Flags

All `mcp-remote` flags are supported (this package is a superset of `mcp-remote`):

| Flag | Description |
|------|-------------|
| `--header "Key: Value"` | Custom headers for remote servers |
| `--transport <strategy>` | `http-first` (default), `sse-first`, `http-only`, `sse-only` |
| `--allow-http` | Allow HTTP (non-TLS) connections |
| `--debug` | Write debug logs to `~/.mcp-auth/{hash}_debug.log` |
| `--silent` | Suppress default logs |
| `--ignore-tool <pattern>` | Filter tools by name (supports wildcards) |
| `--resource <url>` | Isolate OAuth sessions for multi-tenant setups |
| `--host <hostname>` | OAuth callback host (default: `localhost`) |
| `--auth-timeout <seconds>` | OAuth callback timeout (default: `30`) |
| `--enable-proxy` | Use `HTTP_PROXY`/`HTTPS_PROXY` env vars |
| `--static-oauth-client-metadata <json\|@file>` | Custom OAuth client metadata |
| `--static-oauth-client-info <json\|@file>` | Pre-registered OAuth client info |

## Testing

```bash
# Unit tests (134 tests covering all transform phases)
pnpm test:unit

# E2E tests (requires network — tests against real MCP servers)
cd test && pnpm install && pnpm test
```

## Architecture

```
src/
├── proxy.ts              # CLI entrypoint — stdio ↔ remote proxy
├── client.ts             # Debug client mode
└── lib/
    ├── transforms.ts     # 🔑 Gemini schema transform pipeline (7 phases)
    ├── transforms.test.ts # 134 unit tests for transforms
    ├── utils.ts          # Transport, proxy logic, mcpProxy()
    ├── coordination.ts   # OAuth lazy auth coordinator
    ├── node-oauth-client-provider.ts  # OAuth client implementation
    └── types.ts          # Shared types
```

## Credits

Built on top of [`mcp-remote`](https://github.com/geelen/mcp-remote) by Glen Maddern. The proxy infrastructure (stdio ↔ SSE/HTTP bridge, OAuth flows) comes from `mcp-remote` — this package adds the Gemini schema compatibility layer.

## License

MIT
