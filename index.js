/**
 * Obsidian MCP Server — connects Obsidian vault (via Dropbox API) to Claude
 *
 * Architecture:
 *   - Factory pattern: Each SSE request gets its own isolated MCP server instance
 *   - Absolute URL generation via Express headers (x-forwarded-proto, host)
 *   - No authentication — generic MCP server
 *   - CORS enabled for Claude.ai domain
 *   - Session-aware transport routing for POST messages
 *   - Production-ready error handling and cleanup
 */

import express from "express";
import cors from "cors";
import { Dropbox } from "dropbox";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Environment ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const DROPBOX_ACCESS_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;
const OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || "/Obsidian Vault";

if (!DROPBOX_ACCESS_TOKEN) {
  console.error("[FATAL] DROPBOX_ACCESS_TOKEN environment variable is required");
  process.exit(1);
}

// ─── Dropbox Client Factory ───────────────────────────────────────────────────

function createDropboxClient() {
  return new Dropbox({ accessToken: DROPBOX_ACCESS_TOKEN });
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_vault_files",
    description:
      "List all Markdown files in the Obsidian vault. " +
      "Returns file paths and last-modified timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "Subfolder path within the vault (optional). Defaults to vault root.",
        },
      },
      required: [],
    },
  },
  {
    name: "read_note",
    description:
      "Read the full contents of a specific Obsidian note. " +
      "Provide the exact file path as returned by list_vault_files.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Full file path of the note within the vault (e.g., 'Projects/Ideas.md').",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "search_vault",
    description:
      "Search the Obsidian vault for notes containing the given query string. " +
      "Searches file names and content.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string to look for in note titles and content.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "write_note",
    description:
      "Create or overwrite a note in the Obsidian vault. " +
      "If the note exists, it will be overwritten.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path for the note (e.g., 'Projects/New Idea.md').",
        },
        content: {
          type: "string",
          description: "Markdown content to write to the note.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "append_to_note",
    description:
      "Append content to the end of an existing Obsidian note. " +
      "Creates the note if it does not exist.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path of the note (e.g., 'Journal/2024-01-15.md').",
        },
        content: {
          type: "string",
          description: "Markdown content to append to the note.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_folders",
    description:
      "List all folders within a given path in the Obsidian vault. " +
      "Useful for navigating the vault structure.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Folder path within the vault. Defaults to vault root.",
        },
      },
      required: [],
    },
  },
];

// ─── Tool Handlers ────────────────────────────────────────────────────────────

async function handleListVaultFiles(args) {
  const dbx = createDropboxClient();
  const folder = args.folder || "";
  const fullPath = `${OBSIDIAN_VAULT_PATH}/${folder}`.replace(/\/+/g, "/");

  const response = await dbx.filesListFolder({ path: fullPath });
  const files = response.result.entries
    .filter((entry) => entry[".tag"] === "file" && entry.name.endsWith(".md"))
    .map((file) => ({
      name: file.name,
      path: file.path_display.replace(OBSIDIAN_VAULT_PATH + "/", ""),
      modified: file.server_modified,
    }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(files, null, 2),
      },
    ],
  };
}

async function handleReadNote(args) {
  const dbx = createDropboxClient();
  const fullPath = `${OBSIDIAN_VAULT_PATH}/${args.path}`.replace(/\/+/g, "/");

  const response = await dbx.filesDownload({ path: fullPath });
  const content = response.result.fileBinary
    ? Buffer.from(response.result.fileBinary).toString("utf-8")
    : response.result;

  return {
    content: [
      {
        type: "text",
        text: content,
      },
    ],
  };
}

async function handleSearchVault(args) {
  const dbx = createDropboxClient();
  const query = args.query.toLowerCase();

  // List all files recursively and filter client-side
  // Dropbox search API v2 doesn't support content search well, so we scan
  const allFiles = await listAllFilesRecursive(dbx, OBSIDIAN_VAULT_PATH);
  const matchingFiles = [];

  for (const file of allFiles) {
    if (!file.name.endsWith(".md")) continue;

    const nameMatch = file.name.toLowerCase().includes(query);
    let contentMatch = false;

    if (!nameMatch) {
      try {
        const response = await dbx.filesDownload({ path: file.path_display });
        const content = response.result.fileBinary
          ? Buffer.from(response.result.fileBinary).toString("utf-8")
          : "";
        contentMatch = content.toLowerCase().includes(query);
      } catch {
        // Skip files that can't be read
      }
    }

    if (nameMatch || contentMatch) {
      matchingFiles.push({
        name: file.name,
        path: file.path_display.replace(OBSIDIAN_VAULT_PATH + "/", ""),
        modified: file.server_modified,
      });
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(matchingFiles, null, 2),
      },
    ],
  };
}

async function handleWriteNote(args) {
  const dbx = createDropboxClient();
  const fullPath = `${OBSIDIAN_VAULT_PATH}/${args.path}`.replace(/\/+/g, "/");

  await dbx.filesUpload({
    path: fullPath,
    contents: args.content,
    mode: { ".tag": "overwrite" },
    autorename: false,
  });

  return {
    content: [
      {
        type: "text",
        text: `Note written successfully: ${args.path}`,
      },
    ],
  };
}

async function handleAppendToNote(args) {
  const dbx = createDropboxClient();
  const fullPath = `${OBSIDIAN_VAULT_PATH}/${args.path}`.replace(/\/+/g, "/");

  let existingContent = "";
  try {
    const response = await dbx.filesDownload({ path: fullPath });
    existingContent = response.result.fileBinary
      ? Buffer.from(response.result.fileBinary).toString("utf-8")
      : "";
  } catch (err) {
    if (err.status !== 409) throw err;
    // File doesn't exist, we'll create it
  }

  const newContent = existingContent
    ? existingContent + "\n\n" + args.content
    : args.content;

  await dbx.filesUpload({
    path: fullPath,
    contents: newContent,
    mode: { ".tag": "overwrite" },
    autorename: false,
  });

  return {
    content: [
      {
        type: "text",
        text: `Content appended successfully to: ${args.path}`,
      },
    ],
  };
}

async function handleListFolders(args) {
  const dbx = createDropboxClient();
  const folderPath = args.path || "";
  const fullPath = `${OBSIDIAN_VAULT_PATH}/${folderPath}`.replace(/\/+/g, "/");

  const response = await dbx.filesListFolder({ path: fullPath });
  const folders = response.result.entries
    .filter((entry) => entry[".tag"] === "folder")
    .map((folder) => ({
      name: folder.name,
      path: folder.path_display.replace(OBSIDIAN_VAULT_PATH + "/", ""),
    }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(folders, null, 2),
      },
    ],
  };
}

// ─── Helper: Recursively list all files ───────────────────────────────────────

async function listAllFilesRecursive(dbx, path, accum = []) {
  const response = await dbx.filesListFolder({ path });
  const entries = response.result.entries;

  for (const entry of entries) {
    if (entry[".tag"] === "file") {
      accum.push(entry);
    } else if (entry[".tag"] === "folder") {
      await listAllFilesRecursive(dbx, entry.path_display, accum);
    }
  }

  return accum;
}

// ─── MCP Server Factory (CRITICAL: per-transport isolation) ───────────────────

/**
 * Factory function: Creates a fresh MCP server instance.
 * MUST be called inside the /sse route handler — never reuse across transports.
 */
function createMcpServer() {
  const server = new Server(
    { name: "obsidian-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "list_vault_files":
          return await handleListVaultFiles(args);
        case "read_note":
          return await handleReadNote(args);
        case "search_vault":
          return await handleSearchVault(args);
        case "write_note":
          return await handleWriteNote(args);
        case "append_to_note":
          return await handleAppendToNote(args);
        case "list_folders":
          return await handleListFolders(args);
        default:
          return {
            content: [
              { type: "text", text: `Unknown tool: ${name}` },
            ],
            isError: true,
          };
      }
    } catch (err) {
      console.error(`[Tool Error] ${name}:`, err.message);
      return {
        content: [
          { type: "text", text: `Error executing ${name}: ${err.message}` },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// ─── Express Application ──────────────────────────────────────────────────────

const app = express();

// Enable CORS for Claude.ai and local development
app.use(
  cors({
    origin: ["https://claude.ai", "https://www.claude.ai", "http://localhost:3000"],
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));

// ─── Session-to-Transport Map ─────────────────────────────────────────────────

const transports = new Map();

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    server: "obsidian-mcp-server",
    version: "1.0.0",
  });
});

// ─── SSE Endpoint (Factory Pattern — CRITICAL) ────────────────────────────────

app.get("/sse", async (req, res) => {
  // Generate absolute URL for the messages endpoint using request headers
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const messagesUrl = `${protocol}://${host}/messages`;

  console.log(`[SSE] New connection from ${req.ip} — messages URL: ${messagesUrl}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // CRITICAL: Create a fresh server instance for THIS transport only.
  // Reusing a server across transports causes:
  //   "Already connected to a transport" errors
  // ═══════════════════════════════════════════════════════════════════════════
  const server = createMcpServer();

  const transport = new SSEServerTransport(messagesUrl, res);

  // Store transport by session ID for POST routing
  transports.set(transport.sessionId, transport);

  // Clean up on client disconnect
  const cleanup = () => {
    console.log(`[SSE] Connection closed — session: ${transport.sessionId}`);
    transports.delete(transport.sessionId);
    // The server instance will be garbage-collected since no references remain
  };

  res.on("close", cleanup);
  res.on("error", (err) => {
    console.error(`[SSE] Connection error — session: ${transport.sessionId}:`, err.message);
    cleanup();
  });

  // Connect this unique server instance to this unique transport
  await server.connect(transport);
});

// ─── Messages Endpoint (POST) ─────────────────────────────────────────────────

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "Missing or invalid sessionId query parameter" });
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    return res.status(404).json({ error: `No active SSE session found for ID: ${sessionId}` });
  }

  await transport.handlePostMessage(req, res);
});

// ─── Global Error Handling ────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error("[Express Error]", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[${signal}] Shutting down gracefully...`);

  // Close all active transports to prevent memory leaks
  for (const [sessionId, transport] of transports) {
    console.log(`[Shutdown] Closing transport: ${sessionId}`);
    try {
      transport.close && transport.close();
    } catch {
      // Best-effort cleanup
    }
  }
  transports.clear();

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`  Obsidian MCP Server`);
  console.log(`  Listening on port ${PORT}`);
  console.log(`  Vault path: ${OBSIDIAN_VAULT_PATH}`);
  console.log(`  SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`  Messages endpoint: http://localhost:${PORT}/messages`);
  console.log(`═══════════════════════════════════════════════════════════`);
});
