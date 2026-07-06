#!/usr/bin/env node
// puffa-drive-mcp — Claude Code MCP server for the Puffa Drive.
// Auth: PUFFA_KEY env var (shared key issued by Dor).
// Base URL override for local dev: PUFFA_DRIVE_URL.

import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join, relative, basename, dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { upload } from "@vercel/blob/client";

const BASE = process.env.PUFFA_DRIVE_URL || "https://admin.puffa.co.il";
const KEY = process.env.PUFFA_KEY;
if (!KEY) {
  console.error("PUFFA_KEY env var is required (claude mcp add ... -e PUFFA_KEY=<key>)");
  process.exit(1);
}

const JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
// Legacy uploads carry a random `-Xxxx…` suffix before the extension.
const RANDOM_SUFFIX_RE = /-[A-Za-z0-9]{20,}(?=\.[a-z0-9]+$)/i;
const normalized = (p) => p.replace(RANDOM_SUFFIX_RE, "");

async function listDrive(prefix) {
  const url = new URL("/api/mcp/list", BASE);
  if (prefix) url.searchParams.set("prefix", prefix);
  const res = await fetch(url, { headers: { "x-api-key": KEY } });
  if (!res.ok) throw new Error(`list failed: HTTP ${res.status} ${await res.text()}`);
  const { blobs } = await res.json();
  return blobs;
}

async function uploadOne(drivePath, localPath) {
  const content = await readFile(localPath);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await upload(drivePath, content, {
        access: "public",
        handleUploadUrl: `${BASE}/api/files/upload`,
        clientPayload: KEY,
        multipart: content.length > 8 * 1024 * 1024,
      });
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && !JUNK.has(entry.name)) yield full;
  }
}

async function pool(items, size, fn) {
  const queue = [...items];
  const results = [];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        results.push(await fn(item));
      }
    })
  );
  return results;
}

const server = new McpServer({ name: "puffa-drive", version: "1.0.0" });

server.registerTool(
  "upload_folder",
  {
    description:
      "Upload a local folder (recursively) to the Puffa Drive. Resumable: files already " +
      "in the Drive at the same path+size are skipped, so re-running continues where it stopped.",
    inputSchema: {
      localPath: z.string().describe("Absolute path of the local folder"),
      drivePrefix: z
        .string()
        .optional()
        .describe("Destination folder in the Drive (default: the local folder's name)"),
    },
  },
  async ({ localPath, drivePrefix }) => {
    const root = localPath.replace(/\/+$/, "");
    const prefix = (drivePrefix || basename(root)).replace(/^\/+|\/+$/g, "");
    const files = [];
    for await (const f of walk(root)) files.push(f);
    if (!files.length) return { content: [{ type: "text", text: "Folder is empty." }] };

    const existing = new Set(
      (await listDrive(prefix)).map((b) => `${normalized(b.pathname)}|${b.size}`)
    );
    const todo = [];
    let skipped = 0;
    for (const f of files) {
      const drivePath = `${prefix}/${relative(root, f)}`;
      const { size } = await stat(f);
      if (existing.has(`${drivePath}|${size}`)) skipped++;
      else todo.push({ f, drivePath });
    }

    const failures = [];
    let done = 0;
    await pool(todo, 4, async ({ f, drivePath }) => {
      try {
        await uploadOne(drivePath, f);
        done++;
        console.error(`[puffa-drive] ${done}/${todo.length} ${drivePath}`);
      } catch (e) {
        failures.push(`${drivePath}: ${e.message}`);
      }
    });

    const lines = [
      `Uploaded ${done}/${files.length} to "${prefix}/"`,
      skipped ? `${skipped} already existed (skipped)` : null,
      failures.length
        ? `FAILED ${failures.length}:\n${failures.slice(0, 10).join("\n")}${failures.length > 10 ? "\n…" : ""}\nRe-run the same call to retry just the failures.`
        : null,
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "upload_file",
  {
    description: "Upload a single local file to the Puffa Drive.",
    inputSchema: {
      localPath: z.string().describe("Absolute path of the local file"),
      drivePath: z
        .string()
        .optional()
        .describe("Destination path in the Drive (default: the file's name)"),
    },
  },
  async ({ localPath, drivePath }) => {
    const dest = (drivePath || basename(localPath)).replace(/^\/+/, "");
    const blob = await uploadOne(dest, localPath);
    return { content: [{ type: "text", text: `Uploaded → ${blob.pathname}\n${blob.url}` }] };
  }
);

server.registerTool(
  "list_drive",
  {
    description: "List files in the Puffa Drive, optionally under a folder prefix.",
    inputSchema: {
      prefix: z.string().optional().describe("Folder prefix to list (default: everything)"),
    },
  },
  async ({ prefix }) => {
    const blobs = await listDrive(prefix);
    const text = blobs.length
      ? blobs
          .map((b) => `${b.pathname}  (${(b.size / 1e6).toFixed(1)}MB)`)
          .join("\n")
      : "No files found.";
    return { content: [{ type: "text", text: `${blobs.length} files\n${text}` }] };
  }
);

server.registerTool(
  "download_file",
  {
    description: "Download one file from the Puffa Drive to a local path.",
    inputSchema: {
      drivePath: z.string().describe("Path of the file in the Drive"),
      localPath: z.string().describe("Absolute local destination path"),
    },
  },
  async ({ drivePath, localPath }) => {
    const match = (await listDrive(drivePath)).find(
      (b) => b.pathname === drivePath || normalized(b.pathname) === drivePath
    );
    if (!match) throw new Error(`Not found in Drive: ${drivePath}`);
    const res = await fetch(match.url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, Buffer.from(await res.arrayBuffer()));
    return { content: [{ type: "text", text: `Saved → ${localPath}` }] };
  }
);

server.registerTool(
  "download_folder",
  {
    description:
      "Download a whole Drive folder to a local directory, preserving structure. " +
      "Resumable: local files with matching size are skipped.",
    inputSchema: {
      drivePrefix: z.string().describe("Drive folder to download"),
      localPath: z.string().describe("Absolute local destination directory"),
    },
  },
  async ({ drivePrefix, localPath }) => {
    const prefix = drivePrefix.replace(/^\/+|\/+$/g, "");
    const blobs = await listDrive(prefix);
    if (!blobs.length) return { content: [{ type: "text", text: "No files under that prefix." }] };

    const failures = [];
    let done = 0;
    let skipped = 0;
    await pool(blobs, 4, async (b) => {
      const rel = normalized(b.pathname).slice(prefix.length).replace(/^\/+/, "");
      const dest = join(localPath, rel);
      try {
        const st = await stat(dest).catch(() => null);
        if (st && st.size === b.size) {
          skipped++;
          return;
        }
        const res = await fetch(b.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, Buffer.from(await res.arrayBuffer()));
        done++;
        console.error(`[puffa-drive] ${done}/${blobs.length} ${rel}`);
      } catch (e) {
        failures.push(`${b.pathname}: ${e.message}`);
      }
    });

    const lines = [
      `Downloaded ${done}/${blobs.length} → ${localPath}`,
      skipped ? `${skipped} already present (skipped)` : null,
      failures.length ? `FAILED ${failures.length}:\n${failures.slice(0, 10).join("\n")}` : null,
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[puffa-drive] ready → ${BASE}`);
