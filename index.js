import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Dropbox } from 'dropbox';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// 1. PÁGINA INICIAL PARA VOCÊ TESTAR NO NAVEGADOR
app.get("/", (req, res) => {
  res.send(`
    <html>
      <body style="font-family: sans-serif; padding: 2rem; background: #1e1e1e; color: #fff;">
        <h2 style="color: #4ade80;">✅ Servidor MCP está ONLINE!</h2>
        <p>O seu trem chegou à estação com sucesso. O sistema está aguardando o Claude se conectar na rota /sse.</p>
      </body>
    </html>
  `);
});

// 2. CONEXÃO DROPBOX
const dbx = new Dropbox({ accessToken: process.env.DROPBOX_ACCESS_TOKEN });
const VAULT_ROOT = '/Brain';

// 3. CONFIGURAÇÃO MCP
const mcpServer = new Server({
  name: "obsidian-dropbox",
  version: "1.2.0"
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

// ... (Restante das ferramentas de leitura e escrita do Dropbox)
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
    return { isError: true, content: [{ type: "text", text: `Erro: ${error.message}` }] };
  }
});

// 4. SISTEMA DE SESSÕES COM URL ABSOLUTA (A CHAVE DO PROBLEMA)
const transports = new Map();

app.get("/sse", async (req, res) => {
  console.log(">>> [SSE] O Claude iniciou o handshake de conexão!");
  
  // Captura o protocolo e o domínio exato que o Railway gerou
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  
  // Cria a URL de retorno absoluta (Ex: https://seu-app.railway.app/messages)
  const absoluteMessagesUrl = `${protocol}://${host}/messages`;
  console.log(">>> [SSE] URL de retorno absoluta enviada para o Claude:", absoluteMessagesUrl);
  
  const transport = new SSEServerTransport(absoluteMessagesUrl, res);
  
  transports.set(transport.sessionId, transport);
  await mcpServer.connect(transport);
  
  req.on('close', () => {
    console.log(`<<< [SSE] Conexão fechada (Sessão: ${transport.sessionId})`);
    transports.delete(transport.sessionId);
  });
});

app.post("/messages", async (req, res) => {
  console.log(">>> [POST] Recebendo comando na rota /messages");
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  
  if (!transport) {
    console.error("ERRO: Sessão não encontrada para o ID:", sessionId);
    return res.status(404).send("Session not found");
  }
  
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando lindamente na porta ${PORT}`);
});