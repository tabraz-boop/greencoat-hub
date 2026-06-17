# Famly MCP server

A small, local [MCP](https://modelcontextprotocol.io) server that lets Claude
Desktop query the [Famly](https://docs.famly.co/) childcare platform's public
GraphQL API using your own API token.

## Tools it exposes

| Tool | What it does |
| --- | --- |
| `list_children` | The roster — children, optionally filtered by `site_ids`. |
| `get_attendance` | Child check-in / pick-up / check-out records for a `date` (defaults to today), optionally filtered by site/group. |
| `run_graphql` | Run any GraphQL query you like (escape hatch / for queries copied from GraphiQL). |
| `introspect_schema` | Discover the real schema — root query fields, or the fields of a named type. |

> **Note on the two convenience queries.** Famly's schema is large and the
> exact fields your token can see depend on your account's permissions, so the
> `list_children` and `get_attendance` queries are **starter queries**. The
> endpoint, authentication and transport are fixed and correct; if a convenience
> query ever returns a GraphQL error like `Cannot query field "x"`, run
> `introspect_schema` (or use Famly's [GraphiQL explorer](https://famlyapi.famly.co/v1/graphiql))
> to find the right names and edit `ROSTER_QUERY` / `ATTENDANCE_QUERY` near the
> top of `famly_mcp_server.py`. `run_graphql` works regardless.

## 1. Get a Famly API access token

In Famly, create a personal API access token (Account / settings → developer /
API access — see Famly's [Public API Guide](https://help.famly.co/en/articles/10057605-famly-s-public-api-guide)).
The server sends it in the `X-Famly-Accesstoken` header. Treat it like a
password.

## 2. Choose how Claude Desktop launches the server

### Option A — `uv` (recommended, no manual install)

Install [`uv`](https://docs.astral.sh/uv/) if you don't have it. The script
declares its own dependencies (PEP 723 inline metadata), so `uv run` installs
`mcp` + `httpx` into a cached environment automatically the first time.

### Option B — plain virtualenv (fallback)

```bash
cd tools/famly-mcp
uv venv            # or: python3 -m venv .venv
uv pip install -r <(echo "mcp>=1.2.0"; echo "httpx>=0.27.0")
# or, without uv:  .venv/bin/pip install mcp httpx
```

## 3. Add the server to `claude_desktop_config.json`

Open the config from **Claude Desktop → Settings → Developer → Edit Config**, or
edit the file directly:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Paste **one** of the blocks below. Replace `/ABSOLUTE/PATH/TO/...` with the real
absolute path to this folder and paste your token. (If you already have an
`mcpServers` object, just add the `"famly"` key inside it.)

### Option A — `uv`

```json
{
  "mcpServers": {
    "famly": {
      "command": "uv",
      "args": [
        "run",
        "/ABSOLUTE/PATH/TO/greencoat-hub/tools/famly-mcp/famly_mcp_server.py"
      ],
      "env": {
        "FAMLY_ACCESS_TOKEN": "paste-your-famly-api-token-here"
      }
    }
  }
}
```

> Claude Desktop runs `command` directly (not through a shell), and GUI apps on
> macOS often don't inherit your terminal's `PATH`. If the server fails to
> start, replace `"uv"` with the absolute path to the `uv` binary — find it with
> `which uv` (e.g. `/opt/homebrew/bin/uv` or `~/.local/bin/uv`).

### Option B — virtualenv Python

```json
{
  "mcpServers": {
    "famly": {
      "command": "/ABSOLUTE/PATH/TO/greencoat-hub/tools/famly-mcp/.venv/bin/python",
      "args": [
        "/ABSOLUTE/PATH/TO/greencoat-hub/tools/famly-mcp/famly_mcp_server.py"
      ],
      "env": {
        "FAMLY_ACCESS_TOKEN": "paste-your-famly-api-token-here"
      }
    }
  }
}
```

> On Windows the interpreter path is `...\.venv\Scripts\python.exe`, and JSON
> requires escaped backslashes (`\\`).

**Optional:** add `"FAMLY_API_BASE_URL": "https://famlyapi.famly.de/v1/graphql"`
to the `env` block if your account is on Famly's DACH region.

## 4. Restart Claude Desktop

Fully quit and reopen Claude Desktop. The `famly` tools should appear in the
tools menu (the slider/hammer icon). Try asking:

> "List today's attendance for our nursery" or "Show me the children roster."

If a convenience tool errors, ask Claude to "introspect the Famly schema" first,
then adjust the starter queries as described above.

## Security

- Your token lives in `claude_desktop_config.json` in plain text — protect that
  file. The server only reads the token from its environment and sends it to
  Famly over HTTPS; it never logs or writes it.
- `.venv/`, `.env` and `*.token` are git-ignored so secrets don't get committed.
