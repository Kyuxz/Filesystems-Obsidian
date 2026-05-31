import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Dropbox } from 'dropbox';
import cors from 'cors';

const app = express();
app.use(cors()); // Libera o acesso para o Claude
app.use(express.json());

// CONEXÃO DROPBOX
const dbx = new Dropbox({ accessToken: process.env.DROPBOX_ACCESS_TOKEN });
const VAULT_ROOT = '/Brain'; // Alinha direto com a pasta do seu Obsidian

// CONFIGURAÇÃO MCP
const mcpServer = new Server({
  name: "obsidian-dropbox-cloud",
  version: "1.1.0"
}, {
  capabilities: { tools: {} }
});

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ler_nota",
      description: "Lê o conteúdo de uma nota específica (.md) no Obsidian.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Caminho da nota (ex: /Projetos/Ideias.md)" }
        },
        required: ["path"]
      }
    },
    {
      name: "escrever_nota",
      description: "Cria ou sobrescreve uma nota (.md) no Obsidian.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Caminho da nota (ex: /Notas/Diario.md)" },
          conteudo: { type: "string", description: "Conteúdo em Markdown" }
        },
        required: ["path", "conteudo"]
      }
    }
  ]
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const dbxPath = `${VAULT_ROOT}${args.path.startsWith('/') ? '' : '/'}${args.path}`;

  try {
    if (name === "ler_nota") {
      const response = await dbx.filesDownload({ path: dbxPath });
      const text = Buffer.from(response.result.fileBinary).toString('utf-8');
      return { content: [{ type: "text", text }] };
    } 
    
    if (name === "escrever_nota") {
      await dbx.filesUpload({
        path: dbxPath,
        contents: Buffer.from(args.conteudo, 'utf-8'),
        mode: { '.tag': 'overwrite' }
      });
      return { content: [{ type: "text", text: `Nota salva com sucesso em: ${args.path}` }] };
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Erro: ${error.message}` }]
    };
  }
});

// GERENCIADOR DE SESSÕES MCP
const transports = new Map();

app.get("/sse", async (req, res) => {
  console.log("Iniciando Handshake SSE com o Claude...");
  const transport = new SSEServerTransport("/messages", res);
  
  transports.set(transport.sessionId, transport);
  await mcpServer.connect(transport);
  
  req.on('close', () => {
    console.log(`Conexão fechada: ${transport.sessionId}`);
    transports.delete(transport.sessionId);
  });
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  
  if (!transport) {
    return res.status(404).send("Session not found");
  }
  
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});