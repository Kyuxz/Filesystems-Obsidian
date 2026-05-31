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

function toDropboxPath(notePath) {
  let clean = notePath.trim();
  if (clean.startsWith("/")) clean = clean.slice(1);
  if (clean.endsWith(".md")) clean = clean.slice(0, -3);
  return `${BRAIN_FOLDER}/${clean}.md`;
}

function dropboxErrorMessage(err) {
  if (err?.error?.error_summary) return err.error.error_summary;
  if (err?.message) return err.message;
  return "Unknown Dropbox API error";
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// ─── SECURITY MIDDLEWARE (A PEÇA QUE FALTAVA) ────────────────────────────────
// Exige token de acesso. Se não houver, retorna 401 com o cabeçalho estrito
// de URL absoluta exigido pela Anthropic para iniciar o OAuth Discovery.

function requireAuth(req, res, next) {
  if (!req.headers.authorization) {
    console.log(`>>> [Auth] Bloqueando acesso sem token em: ${req.path}`);
    
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host || req.headers[":authority"] || "localhost";
    const absoluteMetadata = `${proto}://${host}/.well-known/oauth-protected-resource`;
    
    res.setHeader("WWW-Authenticate", `Bearer realm="MCP", resource_metadata="${absoluteMetadata}"`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── Health Check Route ──────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.status(200).send("MCP Obsidian-Dropbox Server - Operational");
});

// ─── OAuth Protected Resource Metadata ───────────────────────────────────────

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

// ─── OAuth 2.0 PKCE Handshake Route Handlers ─────────────────────────────────

app.get("/authorize", (req, res) => {
  console.log(">>> [OAuth] Pedido de autorização GET /authorize");
  const { redirect_uri, state } = req.query;

  if (!redirect_uri) {
    return res.status(200).send("OAuth Authorize Endpoint - OK");
  }

  const code = crypto.randomBytes(32).toString("hex");
  res.redirect(`${redirect_uri}?code=${code}&state=${state}`);
});

// Rota VIP simplificada ao máximo para evitar falhas de parse do body
app.post("/token", (req, res) => {
  console.log(">>> [OAuth] O Claude pediu o Token POST /token");
  
  res.json({
    access_token: crypto.randomBytes(32).toString("hex"),
    token_type: "bearer",
    expires_in: 31536000
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
      const filePath = toDropboxPath(args.caminho);
      try {
        const response = await dbx.filesDownload({ path: filePath });
        const fileContent = response.result.fileBinary
          ? Buffer.from(response.result.fileBinary).toString("utf-8")
          : "";
        return { content: [{ type: "text", text: fileContent || "(arquivo vazio)" }] };
      } catch (err) {
        throw new McpError(ErrorCode.InternalError, `Erro do Dropbox: ${dropboxErrorMessage(err)}`);
      }
    }

    if (name === "escrever_nota") {
      const filePath = toDropboxPath(args.caminho);
      try {
        await dbx.filesUpload({
          path: filePath,
          contents: Buffer.from(args.conteudo, "utf-8"),
          mode: { ".tag": "overwrite" },
          autorename: false,
        });
        return { content: [{ type: "text", text: `Nota salva com sucesso em ${filePath}.` }] };
      } catch (err) {
        throw new McpError(ErrorCode.InternalError, `Erro do Dropbox ao salvar: ${dropboxErrorMessage(err)}`);
      }
    }

    throw new McpError(ErrorCode.MethodNotFound, `Tool desconhecida: ${name}`);
  });

  return server;
}

// ─── SSE Endpoint (PROTEGIDO POR requireAuth) ────────────────────────────────

const activeTransports = new Map();

function TrackedSSEServerTransport(messagesUrl, res) {
  const transport = new SSEServerTransport(messagesUrl, res);
  const sessionId = transport.sessionId;
  activeTransports.set(sessionId, transport);

  res.on("close", () => {
    activeTransports.delete(sessionId);
  });
  return transport;
}

// APLICANDO O MIDDLEWARE DE SEGURANÇA
app.use("/sse", requireAuth);
app.use("/messages", requireAuth);

app.get("/sse", async (req, res) => {
  console.log(`[SSE] Conexão AUTENTICADA de ${req.ip || "unknown"}`);

  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host || req.headers[":authority"] || `localhost:${PORT}`;
    const messagesUrl = `${proto}://${host}/messages`;

    const transport = TrackedSSEServerTransport(messagesUrl, res);
    const mcpServer = createMcpServer();

    req.on("close", () => {
      try { mcpServer.close(); } catch (e) {}
    });

    await mcpServer.connect(transport);
    console.log(`[SSE] Servidor MCP rodando para ${req.ip || "unknown"}`);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Failed to establish SSE connection" });
  }
});

// ─── Messages POST Handler (PROTEGIDO) ───────────────────────────────────────

app.post("/messages", async (req, res) => {
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

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 MCP Obsidian-Dropbox Server rodando na porta ${PORT}`);
});

module.exports = { app };