# puffa-drive-mcp

MCP server for the Puffa Drive (admin.puffa.co.il) — lets Claude Code upload,
list and download Drive files directly from your machine.

## Install (one line)

```bash
claude mcp add puffa-drive -e PUFFA_KEY=<key> -- npx -y github:Ruinous7/puffa-drive-mcp
```

Get the `<key>` from Dor. That's it — then just ask Claude, e.g.:

> תעלה את התיקייה `~/קטלוג-תמונות-Puffa` ל-Drive

## Tools

| Tool | What it does |
|---|---|
| `upload_folder` | Recursive folder upload. **Resumable** — re-running skips what's already there. Retries ×3, 4 parallel. |
| `upload_file` | Single file upload. |
| `list_drive` | List Drive contents, optionally by folder. |
| `download_file` | Pull one file to a local path. |
| `download_folder` | Pull a whole Drive folder, structure preserved, resumable. |

## Env

- `PUFFA_KEY` — required, the shared access key.
- `PUFFA_DRIVE_URL` — optional base-URL override (local dev).
