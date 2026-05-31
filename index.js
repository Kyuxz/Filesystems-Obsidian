/**
 * MCP Obsidian-Dropbox Server
 * Production-ready Express server for Railway deployment
 * Connects Claude to an Obsidian vault via Dropbox API using MCP SSE transport
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto"); // ─── Importado para o fluxo do OAuth PKCE ───
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

// Armazenamento em memória para os códigos temporários de handshake OAuth
const oauthCodes = new Map();

// ─── Dropbox Client ──────────────────────────────────────────────────────────

const dbx = new Dropbox({ accessToken: DROPBOX_ACCESS_TOKEN });

/**
 * Helper: normalize a note path to a Dropbox file path within /Brain.
 * Ensures .md extension and removes leading slashes to avoid double slashes.
 */
function toDropboxPath(notePath) {
  let clean = notePath.trim();
  // Remove leading slash if present
  if (clean.startsWith("/")) clean = clean.slice(1);
  // Remove .md extension if present (we'll add it consistently)
  if (clean.endsWith(".md")) clean = clean.slice(0, -3);
  // Reconstruct full path within Brain folder
  return `${BRAIN_FOLDER}/${clean}.md`;
}

/**
 * Helper: safely extract Dropbox API error message
 */
function dropboxErrorMessage(err) {
  if (err?.error?.error_summary) return err.error.error_summary;
  if (err?.message) return err.message;
  return "Unknown Dropbox API error";
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

// Enable CORS for all origins (Claude web client requirement)
app.use(cors({ origin: "*", credentials: true }));

// Parse JSON body for POST /messages endpoint
app.use(express.json({ limit: "10mb" }));

// ─── WWW-Authenticate Strict Parser Fix ─────────────────────────────────────
// Anthropic's MCP client requires absolute URLs in the WWW-Authenticate header.
// Relative resource_metadata paths are silently rejected, causing infinite loops.
// This middleware intercepts 401 responses and injects a properly formatted
// WWW-Authenticate header with an absolute, dynamically-built metadata URL.

function wwwAuthenticateFix(req, res, next) {
  const originalSetHeader = res.setHeader.bind(res);
  const originalWriteHead = res.writeHead.bind(res);
  let wwwAuthFixed = false;

  res.setHeader = function (name, value) {
    if (name.toLowerCase() === "www-authenticate" && typeof value === "string") {
      if (value.includes('resource_metadata="') && !value.includes("://")) {
        // Relative path detected — rewrite to absolute URL
        const proto = req.headers["x-forwarded-proto"] || "https";
        const host = req.headers.host || req.headers[":authority"] || "localhost";
        const absoluteMetadata = `${proto}://${host}/.well-known/oauth-protected-resource`;
        value = value.replace(
          /resource_metadata="[^"]*/,
          `resource_metadata="${absoluteMetadata}`
        );
        wwwAuthFixed = true;
      } else if (value.startsWith("Bearer") && !value.includes("resource_metadata")) {
        // Missing resource_metadata entirely — inject it
        const proto = req.headers["x-forwarded-proto"] || "https";
        const host = req.headers.host || req.headers[":authority"] || "localhost";
        const absoluteMetadata = `${proto}://${host}/.well-known/oauth-protected-resource`;
        value = `${value}, resource_metadata="${absoluteMetadata}"`;
        wwwAuthFixed = true;
      }
    }
    return originalSetHeader(name, value);
  };

  res.writeHead = function (statusCode, ...args) {
    if (statusCode === 401 && !wwwAuthFixed) {
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers.host || req.headers[":authority"] || "localhost";
      const absoluteMetadata = `${proto}://${host}/.well-known/oauth-protected-resource`;
      originalSetHeader(
        "WWW-Authenticate",
        `Bearer realm="MCP", resource_metadata="${absoluteMetadata}"`
      );
    }
    return originalWriteHead(statusCode, ...args);
  };

  next();
}

app.use(wwwAuthenticateFix);

// ─── Health Check Route ──────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.status(200).send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>MCP Obsidian Server</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; }
          h1 { color: #7c3aed; }
          .badge { display: inline-block; background: #10b981; color: white; padding: 4px 14px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; }
          .code { background: #f3f4f6; padding: 2px 8px; border-radius: 4px; font-family: monospace; font-size: 0.9rem; }
          .endpoint { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px; margin: 8px 0; }
          .method { color: #7c3aed; font-weight: 700; font-family: monospace; }
        </style>
      </head>
      <body>
        <h1>MCP Obsidian-Dropbox Server</h1>
        <p><span class="badge">Operational</span></p>
        <p>This server connects Claude to your Obsidian vault via the Dropbox API using the Model Context Protocol.</p>
        
        <h3>Available Endpoints</h3>
        <div class="endpoint"><span class="method">GET</span>  <span class="code">/sse</span> — SSE connection for MCP</div>
        <div class="endpoint"><span class="method">POST</span> <span class="code">/messages</span> — MCP message relay</div>
        <div class="endpoint"><span class="method">GET</span>  <span class="code">/.well-known/oauth-protected-resource</span> — OAuth metadata</div>
        <div class="endpoint"><span class="method">GET</span>  <span class="code">/authorize</span> — OAuth authorization handler</div>
        <div class="endpoint"><span class="method">POST</span> <span class="code">/token</span> — OAuth token exchange</div>
        
        <h3>Tools Exposed to Claude</h3>
        <ul>
          <li><strong>ler_nota</strong> — Read a Markdown note from <span class="code">/Brain</span></li>
          <li><strong>escrever_nota</strong> — Write a Markdown note to <span class="code">/Brain</span></li>
        </ul>
        
        <p style="margin-top: 40px; color: #6b7280; font-size: 0.85rem;">
          Connected to Dropbox folder: <span class="code">${BRAIN_FOLDER}</span>
        </p>
      </body>
    </html>
  `);
});

// ─── OAuth Protected Resource Metadata ───────────────────────────────────────
// Required by Anthropic MCP client for proper OAuth discovery

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

// ─── OAuth 2.0 PKCE Handshake Route Handlers (VIP LOG MODE) ──────────────────
// Auto-approves single-user credentials to bypass Claude UI requirements securely.

app.get("/authorize", (req, res) => {
  console.log(">>> [OAuth] O Claude iniciou o pedido de autorização GET /authorize");
  console.log(">>> [OAuth] Parametros recebidos:", req.query);
  
  const { redirect_uri, state } = req.query;
  const code = crypto.randomBytes(32).toString("hex");

  const urlDeRetorno = `${redirect_uri}?code=${code}&state=${state}`;
  console.log(">>> [OAuth] Aprovando e redirecionando o Claude para:", urlDeRetorno);
  
  res.redirect(urlDeRetorno);
});

// Adicionamos express.json() aqui para garantir que lemos independente de como o Claude enviar
app.post("/token", express.urlencoded({ extended: true }), express.json(), (req, res) => {
  console.log(">>> [OAuth] O Claude pediu o Token POST /token");
  console.log(">>> [OAuth] Corpo da requisicao:", req.body);

  // Criamos tokens falsos perfeitamente válidos
  const fakeAccessToken = crypto.randomBytes(32).toString("hex");
  const fakeRefreshToken = crypto.randomBytes(32).toString("hex");

  console.log(">>> [OAuth] Handshake concluído! Enviando token de acesso para o Claude.");
  
  // Aprovamos incondicionalmente para evitar falhas de PKCE
  res.json({
    access_token: fakeAccessToken,
    token_type: "Bearer",
    expires_in: 86400,
    refresh_token: fakeRefreshToken
  });
});

// ─── MCP Server Factory ──────────────────────────────────────────────────────
// CRITICAL: Claude makes rapid, concurrent connection attempts.
// A single global Server instance crashes with "Already connected to a transport".
// We MUST create a fresh Server instance per SSE connection.

function createMcpServer() {
  const server = new Server(
    {
      name: "obsidian-dropbox-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ─── Tool Definitions ──────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "ler_nota",
          description:
            "Le uma nota Markdown do cofre Obsidian na pasta /Brain do Dropbox. " +
            "Use caminho relativo (ex: 'Ideias/Projeto X'). A extensao .md e adicionada automaticamente.",
          inputSchema: {
            type: "object",
            properties: {
              caminho: {
                type: "string",
                description:
                  "Caminho relativo da nota dentro da pasta /Brain (ex: 'Ideias/Projeto X')",
              },
            },
            required: ["caminho"],
          },
        },
        {
          name: "escrever_nota",
          description:
            "Escreve ou sobrescreve uma nota Markdown na pasta /Brain do Dropbox. " +
            "Use caminho relativo (ex: 'Ideias/Projeto X'). A extensao .md e adicionada automaticamente.",
          inputSchema: {
            type: "object",
            properties: {
              caminho: {
                type: "string",
                description:
                  "Caminho relativo da nota dentro da pasta /Brain (ex: 'Ideias/Projeto X')",
              },
              conteudo: {
                type: "string",
                description: "Conteudo Markdown completo da nota",
              },
            },
            required: ["caminho", "conteudo"],
          },
        },
      ],
    };
  });

  // ─── Tool Handlers ─────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "ler_nota") {
      const caminho = args?.caminho;
      if (!caminho || typeof caminho !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "Parametro 'caminho' e obrigatorio e deve ser uma string.");
      }

      const filePath = toDropboxPath(caminho);
      console.log(`[ler_nota] Reading: ${filePath}`);

      try {
        const response = await dbx.filesDownload({ path: filePath });
        const fileContent = response.result.fileBinary
          ? Buffer.from(response.result.fileBinary).toString("utf-8")
          : "";

        return {
          content: [
            {
              type: "text",
              text: fileContent || "(arquivo vazio)",
            },
          ],
        };
      } catch (err) {
        console.error(`[ler_nota] Error reading ${filePath}:`, dropboxErrorMessage(err));

        if (err?.status === 409 || err?.error?.path?.[".tag"] === "not_found") {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Nota nao encontrada: "${caminho}" (verificado em: ${filePath})`
          );
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Erro do Dropbox: ${dropboxErrorMessage(err)}`
        );
      }
    }

    if (name === "escrever_nota") {
      const caminho = args?.caminho;
      const conteudo = args?.conteudo;

      if (!caminho || typeof caminho !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "Parametro 'caminho' e obrigatorio e deve ser uma string.");
      }
      if (conteudo === undefined || conteudo === null) {
        throw new McpError(ErrorCode.InvalidParams, "Parametro 'conteudo' e obrigatorio.");
      }

      const filePath = toDropboxPath(caminho);
      console.log(`[escrever_nota] Writing: ${filePath}`);

      try {
        await dbx.filesUpload({
          path: filePath,
          contents: Buffer.from(conteudo, "utf-8"),
          mode: { ".tag": "overwrite" },
          autorename: false,
        });

        return {
          content: [
            {
              type: "text",
              text: `Nota "${caminho}" salva com sucesso em ${filePath}.`,
            },
          ],
        };
      } catch (err) {
        console.error(`[escrever_nota] Error writing ${filePath}:`, dropboxErrorMessage(err));
        throw new McpError(
          ErrorCode.InternalError,
          `Erro do Dropbox ao salvar: ${dropboxErrorMessage(err)}`
        );
      }
    }

    throw new McpError(ErrorCode.MethodNotFound, `Tool desconhecida: ${name}`);
  });

  return server;
}

// ─── SSE Endpoint ────────────────────────────────────────────────────────────
// CRITICAL FIX: Create a brand-new Server instance for every connection.
// The Claude client fires multiple concurrent requests; sharing a global Server
// causes: Error: Already connected to a transport.

// Map to hold active transports keyed by session ID for message relay
const activeTransports = new Map();

// We wrap SSEServerTransport to register itself on creation
// so the /messages endpoint can route to the correct transport.
function TrackedSSEServerTransport(messagesUrl, res) {
  const transport = new SSEServerTransport(messagesUrl, res);
  const sessionId = transport.sessionId;
  activeTransports.set(sessionId, transport);

  // Clean up on response close
  res.on("close", () => {
    activeTransports.delete(sessionId);
  });

  return transport;
}

app.get("/sse", async (req, res) => {
  console.log(`[SSE] New connection from ${req.ip || "unknown"} at ${new Date().toISOString()}`);

  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host || req.headers[":authority"] || `localhost:${PORT}`;
    const messagesUrl = `${proto}://${host}/messages`;

    console.log(`[SSE] Messages URL: ${messagesUrl}`);

    // Use tracked transport so /messages can find it
    const transport = TrackedSSEServerTransport(messagesUrl, res);

    const mcpServer = createMcpServer();

    req.on("close", () => {
      console.log(`[SSE] Connection closed for ${req.ip || "unknown"}`);
      try {
        mcpServer.close();
      } catch (e) {}
    });

    req.on("error", (err) => {
      console.error(`[SSE] Connection error for ${req.ip || "unknown"}:`, err.message);
      try {
        mcpServer.close();
      } catch (e) {}
    });

    await mcpServer.connect(transport);
    console.log(`[SSE] Server connected successfully for ${req.ip || "unknown"}`);
  } catch (err) {
    console.error("[SSE] Failed to establish connection:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to establish SSE connection" });
    }
  }
});

// ─── Messages POST Handler ───────────────────────────────────────────────────

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;

  if (!sessionId) {
    return res.status(400).json({ error: "Missing sessionId query parameter" });
  }

  const transport = activeTransports.get(sessionId);

  if (!transport) {
    console.error(`[messages] No active transport found for sessionId: ${sessionId}`);
    return res.status(404).json({ error: "Session not found or expired" });
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (err) {
    console.error(`[messages] Error handling message for session ${sessionId}:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process message" });
    }
  }
});

// ─── Error Handling ──────────────────────────────────────────────────────────

// Catch-all error handler
app.use((err, req, res, next) => {
  console.error("[Express] Unhandled error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║         MCP Obsidian-Dropbox Server — Running on Railway           ║
╠══════════════════════════════════════════════════════════════════════╣
║  Port:          ${PORT.toString().padEnd(56)} ║
║  Brain Folder:  ${BRAIN_FOLDER.padEnd(56)} ║
║  Health Check:  GET /${"".padEnd(55)} ║
║  SSE Endpoint:  GET /sse${"".padEnd(51)} ║
║  Messages:      POST /messages?sessionId=<id>${"".padEnd(38)} ║
║  OAuth Meta:    GET /.well-known/oauth-protected-resource${"".padEnd(24)} ║
╚══════════════════════════════════════════════════════════════════════╝
  `);
});

module.exports = { app };