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

## Hebrew quality boundary

The creative tools are thin forwarders. Hebrew review and memory live in the
shared Shavek server and Supabase database, scoped to Puffa's business profile.

- `generate_copy` reviews and persists its draft before returning corrected
  Hebrew.
- `generate_vo` separately reviews and persists its spoken Hebrew before
  ElevenLabs synthesis.
- `accept_hebrew_review` explicitly approves a stored review so its resolved
  corrections become Puffa-specific guidance for later generated copy and VO.

The gate is an editorial safeguard, not a mathematical guarantee and not a
niqqud/pronunciation compiler. Serious unresolved ambiguity fails closed.
