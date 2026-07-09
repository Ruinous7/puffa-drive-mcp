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

async function uploadFolder(localPath, drivePrefix) {
  const root = localPath.replace(/\/+$/, "");
  const prefix = (drivePrefix || basename(root)).replace(/^\/+|\/+$/g, "");
  const files = [];
  for await (const f of walk(root)) files.push(f);
  if (!files.length) return { prefix, total: 0, done: 0, skipped: 0, failures: [] };

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
  return { prefix, total: files.length, done, skipped, failures };
}

function summarize({ prefix, total, done, skipped, failures }) {
  if (!total) return "Folder is empty.";
  return [
    `Uploaded ${done}/${total} to "${prefix}/"`,
    skipped ? `${skipped} already existed (skipped)` : null,
    failures.length
      ? `FAILED ${failures.length}:\n${failures.slice(0, 10).join("\n")}${failures.length > 10 ? "\n…" : ""}\nRe-run the same command to retry just the failures.`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── CLI mode ──────────────────────────────────────────────────────────
// npx -y github:Ruinous7/puffa-drive-mcp upload <localFolder> [drivePrefix]
// One-shot resumable upload — no MCP registration needed.
if (process.argv[2] === "upload") {
  const local = process.argv[3];
  if (!local) {
    console.error("Usage: puffa-drive-mcp upload <localFolder> [drivePrefix]");
    process.exit(1);
  }
  const result = await uploadFolder(local, process.argv[4]);
  console.log(summarize(result));
  process.exit(result.failures.length ? 1 : 0);
}

// ── Creative tools (Puffa Creative MCP) ───────────────────────────────
// Thin forwarders → the Shavek Railway backend (/api/puffa/*), which runs the
// models and meters the Puffa wallet. Auth: PUFFA_SERVICE_KEY shared secret.
const CREATIVE_API = process.env.PUFFA_API_URL || "https://shavek-api-prod-web.up.railway.app";
const SERVICE_KEY = process.env.PUFFA_SERVICE_KEY;

async function callCreative(toolName, body) {
  if (!SERVICE_KEY) {
    throw new Error(
      "PUFFA_SERVICE_KEY env var is required for the creative tools (claude mcp add ... -e PUFFA_SERVICE_KEY=<key>)"
    );
  }
  const res = await fetch(`${CREATIVE_API}/api/puffa/${toolName}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-puffa-service-key": SERVICE_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${toolName} failed: HTTP ${res.status} ${text}`);
  return { content: [{ type: "text", text }] };
}

const mediaRef = z.object({
  url: z.string().optional().describe("Hosted image/media URL (catalog CDN, Drive, or a previous tool's output)"),
  base64: z.string().optional().describe("Inline base64 bytes (alternative to url)"),
  mimeType: z.string().optional(),
});
const jobId = z
  .string()
  .optional()
  .describe("Creative-run id — assets of one run group under one folder. Use the same jobId across all steps of a run.");

const server = new McpServer({ name: "puffa-drive", version: "1.0.0" });

server.registerTool(
  "generate_copy",
  {
    description:
      "Puffa copy engine (Omri's generate-copy.py on Shavek infra). Writes Hebrew UGC copy with the full " +
      "Puffa copy-brain (Cashvertising + CREATIVE_PLAYBOOK + LF8 + BRAND_VOICE + הוקים-רפרנס) loaded server-side " +
      "and the iron rules + policy lock enforced. Tasks: script (VO script), copy (ad copy → 3 channels), headlines (10 hooks).",
    inputSchema: {
      brief: z.string().describe("The brief: product, avatar, LF8 message, hook idea, offer — like Omri's --brief"),
      task: z.enum(["script", "copy", "headlines"]).optional().describe("Default: script"),
      temperature: z.number().optional().describe("Default 0.9"),
    },
  },
  ({ brief, task, temperature }) => callCreative("generate_copy", { brief, task, temperature })
);

server.registerTool(
  "catalog_lookup",
  {
    description:
      "Product-lock: resolve {product, color, types} to the REAL Puffa catalog photo URLs (349 images on " +
      "puffa-katalog.pages.dev) — real fabric, color, angle. Anchor every keyframe on these, never an invented product. " +
      "Types are substring filters, e.g. קדמי/אחורי/ימין/שמאל/לייפסטייל/סווטץ/בית/מידות.",
    inputSchema: {
      product: z.string().optional().describe("Hebrew or English name, e.g. 'ספת ענן' or 'Nimbus'"),
      color: z.string().optional().describe("e.g. 'אפור'"),
      types: z.array(z.string()).optional(),
    },
  },
  ({ product, color, types }) => callCreative("catalog_lookup", { product, color, types })
);

server.registerTool(
  "ingest",
  {
    description:
      "Host a real asset (product photo, anchor frame, logo) in durable storage and get a long-lived URL " +
      "renders can reference — Omri's --image hosting step. Feed it a catalog/Drive URL or inline base64.",
    inputSchema: {
      ref: mediaRef,
      jobId,
      kind: z.string().optional().describe("Path label, e.g. 'anchor' (default 'ingest')"),
    },
  },
  ({ ref, jobId: job, kind }) => callCreative("ingest", { ref, jobId: job, kind })
);

server.registerTool(
  "generate_keyframe",
  {
    description:
      "START / END-on-START keyframe anchored on real reference photos (Omri's nano_banana_2 step). " +
      "Default: Gemini image 'pro' tier, gpt-image fallback. Pass the real product photos as refs; pattern prompts " +
      "on פרומפטים/UGC-ספת-ענן/prompts_realism_*.json. Returns a durable URL for render_shot.",
    inputSchema: {
      prompt: z.string(),
      aspectRatio: z.enum(["1:1", "4:5", "9:16", "16:9"]).optional().describe("Default 9:16"),
      refs: z.array(mediaRef).optional().describe("Anchor photos — catalog URLs / ingested assets. Identity source."),
      provider: z.enum(["gemini", "openai"]).optional(),
      quality: z.enum(["fast", "standard", "pro"]).optional().describe("Default pro"),
      jobId,
      kind: z.string().optional().describe("e.g. 'start-frame' / 'end-frame'"),
    },
  },
  (args) => callCreative("generate_keyframe", args)
);

server.registerTool(
  "render_shot",
  {
    description:
      "Render one video shot from START (+END) keyframes — Omri's seedance_2_0 --start-image --end-image step. " +
      "Chain: Seedance → Kie (person frames) → Veo. Silent by default; VO is muxed in assemble. Takes minutes.",
    inputSchema: {
      prompt: z.string(),
      ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional().describe("Default 9:16"),
      resolution: z.enum(["720p", "1080p", "2k"]).optional().describe("Default 1080p"),
      durationSeconds: z.number().optional().describe("2–12, default 5"),
      tier: z.enum(["standard", "fast"]).optional(),
      firstFrame: mediaRef.optional().describe("START keyframe"),
      lastFrame: mediaRef.optional().describe("END keyframe (interpolation)"),
      referenceImages: z.array(mediaRef).optional(),
      generateAudio: z.boolean().optional().describe("Default false — shots are silent"),
      fallback: z.boolean().optional().describe("false = strict Seedance only (probe mode)"),
      jobId,
    },
  },
  (args) => callCreative("render_shot", args)
);

server.registerTool(
  "generate_vo",
  {
    description:
      "Hebrew voice-over (Omri's generate-vo.py on ElevenLabs) + the blueprint's atempo 1.08 acceleration. " +
      "Segments carry optional [delivery] direction (excited/warmly/softly). Returns durable mp3 URL + word timestamps.",
    inputSchema: {
      segments: z
        .array(z.object({ delivery: z.string().optional(), text: z.string() }))
        .optional()
        .describe("Script beats: spoken text + optional delivery direction"),
      text: z.string().optional().describe("Alternative: one string with inline [delivery] tags"),
      voiceId: z.string().optional().describe("ElevenLabs voice override"),
      jobId,
    },
  },
  (args) => callCreative("generate_vo", args)
);

server.registerTool(
  "assemble",
  {
    description:
      "Mux VO onto a video — Omri's assemble-vo.sh verbatim. Without music the VO replaces the soundtrack; " +
      "with music the track ducks under the voice (sidechaincompress). Returns the final durable mp4 URL.",
    inputSchema: {
      videoUrl: z.string().describe("The rendered video (render_shot output or a concat)"),
      voUrl: z.string().describe("The VO mp3 (generate_vo output)"),
      musicUrl: z.string().optional().describe("Background music to duck under the VO"),
      jobId,
    },
  },
  (args) => callCreative("assemble", args)
);

server.registerTool(
  "edit_image",
  {
    description:
      "Surgical image edit (nano-edit step): change ONLY what the instruction names, preserve everything else — " +
      "composition, subjects, colors, lighting, text, style. gpt-image /edits leads, Gemini fallback.",
    inputSchema: {
      image: mediaRef,
      instruction: z.string(),
      aspectRatio: z.enum(["1:1", "4:5", "9:16", "16:9"]).optional(),
      jobId,
    },
  },
  (args) => callCreative("edit_image", args)
);

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
    const result = await uploadFolder(localPath, drivePrefix);
    return { content: [{ type: "text", text: summarize(result) }] };
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
