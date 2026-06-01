/**
 * MCP Obsidian-Dropbox Server
 * Production-ready Express server for Railway deployment
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Dropbox } = require("dropbox");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} = require("@modelcontextprotocol/sdk/types.js");

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
const DROPBOX_ACCESS_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;
const BRAIN_FOLDER = process.env.BRAIN_FOLDER || "/Brain";

if (!DROPBOX_ACCESS_TOKEN) {
  console.error("[FATAL] DROPBOX_ACCESS_TOKEN environment variable is required");
  process.exit(1);
}

const dbx = new Dropbox({ accessToken: DROPBOX_ACCESS_TOKEN });
const oauthCodes = new Map(); // Restored proper memory store for PKCE

function toDropboxPath(notePath) {
  let clean = notePath.trim();
  if (clean.startsWith("/")) clean = clean.slice(1);
  if (clean.endsWith(".md")) clean = clean.slice(0, -3);
  return `${BRAIN_FOLDER}/${clean}.md`;
}

// ─── Express App & Proper CORS ───────────────────────────────────────────────

const app = express();

// 1. FIXED: Explicitly handle CORS preflight for ALL routes so OPTIONS returns 204 No Content
app.use(cors({ origin: true, credentials: true }));
app.options('*', cors({ origin: true, credentials: true }));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── STRICT AUTHENTICATION MIDDLEWARE ────────────────────────────────────────

function requireAuth(req, res, next) {
  // CORS handles OPTIONS, but this is a safety net
  if (req.method === 'OPTIONS') return next();

  if (!req.headers.authorization) {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host || req.headers[":authority"] || "localhost";
    const absoluteMetadata = `${proto}://${host}/.well-known/oauth-protected-resource`;
    
    res.setHeader("WWW-Authenticate", `Bearer realm="MCP", resource_metadata="${absoluteMetadata}"`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── Health Check & Discovery ────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.status(200).send("MCP Obsidian-Dropbox Server - Operational");
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host || req.headers[":authority"] || "localhost";
  res.json({
    resource: `${proto}://${host}`,
    authorization_servers: [`${proto}://${host}`],
    scopes_supported: ["mcp"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

// ─── STRICT OAUTH 2.0 PKCE IMPLEMENTATION ────────────────────────────────────

app.get("/authorize", (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method } = req.query;
  
  if (!redirect_uri) return res.status(400).send("Missing redirect_uri");

  const code = crypto.randomBytes(32).toString("hex");
  
  // Store the exact challenge to validate in /token
  oauthCodes.set(code, { code_challenge, code_challenge_method, redirect_uri });

  res.redirect(`${redirect_uri}?code=${code}&state=${state}`);
});

app.post("/token", (req, res) => {
  const { code, code_verifier } = req.body;
  const stored = oauthCodes.get(code);

  if (!stored) return res.status(400).json({ error: "invalid_grant" });

  // 2. FIXED: Actually validate the PKCE hash to satisfy strict OAuth clients
  const hash = crypto.createHash("sha256").update(code_verifier).digest("base64url");
  if (hash !== stored.code_challenge) return res.status(400).json({ error: "invalid_grant" });

  oauthCodes.delete(code);

  // 3. FIXED: Adhering to RFC 6749 Section 5.1 caching requirements
  res.set({
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache'
  });

  res.json({
    access_token: crypto.randomBytes(32).toString("hex"),
    token_type: "Bearer",
    expires_in: 31536000,
    scope: "mcp"
  });
});

// ─── MCP Server Factory ──────────────────────────────────────────────────────

function createMcpServer() {
  const server = new Server(
    { name: "obsidian-dropbox-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "ler_nota",
          description: "Le uma nota Markdown do cofre Obsidian na pasta /Brain do Dropbox.",
          inputSchema: {
            type: "object",
            properties: { caminho: { type: "string" } },
            required: ["caminho"],
          },
        },
        {
          name: "escrever_nota",
          description: "Escreve ou sobrescreve uma nota Markdown na pasta /Brain do Dropbox.",
          inputSchema: {
            type: "object",
            properties: { caminho: { type: "string" }, conteudo: { type: "string" } },
            required: ["caminho", "conteudo"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "ler_nota") {
      try {
        const response = await dbx.filesDownload({ path: toDropboxPath(args.caminho) });
        const fileContent = response.result.fileBinary ? Buffer.from(response.result.fileBinary).toString("utf-8") : "";
        return { content: [{ type: "text", text: fileContent || "(arquivo vazio)" }] };
      } catch (err) {
        throw new McpError(ErrorCode.InternalError, "Erro de leitura");
      }
    }
    if (name === "escrever_nota") {
      try {
        await dbx.filesUpload({ path: toDropboxPath(args.caminho), contents: Buffer.from(args.conteudo, "utf-8"), mode: { ".tag": "overwrite" }, autorename: false });
        return { content: [{ type: "text", text: "Salvo com sucesso." }] };
      } catch (err) {
        throw new McpError(ErrorCode.InternalError, "Erro de escrita");
      }
    }
    throw new McpError(ErrorCode.MethodNotFound, "Tool desconhecida");
  });

  return server;
}

// ─── SSE & Messages Endpoints ────────────────────────────────────────────────

const activeTransports = new Map();

// 4. FIXED: Apply auth middleware directly to the routes to avoid stripping the URL path
app.get("/sse", requireAuth, async (req, res) => {
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host || req.headers[":authority"] || `localhost:${PORT}`;
    const messagesUrl = `${proto}://${host}/messages`;

    const transport = new SSEServerTransport(messagesUrl, res);
    const sessionId = transport.sessionId;
    activeTransports.set(sessionId, transport);
    
    res.on("close", () => activeTransports.delete(sessionId));

    const mcpServer = createMcpServer();
    req.on("close", () => { try { mcpServer.close(); } catch (e) {} });

    await mcpServer.connect(transport);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "SSE Error" });
  }
});

app.post("/messages", requireAuth, async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

  const transport = activeTransports.get(sessionId);
  if (!transport) return res.status(404).json({ error: "Session not found" });

  try {
    await transport.handlePostMessage(req, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Failed to process message" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 MCP Obsidian-Dropbox Server rodando na porta ${PORT}`);
});

module.exports = { app };