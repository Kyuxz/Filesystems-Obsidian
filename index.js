import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Dropbox } from 'dropbox';

const app = express();
app.use(express.json());

// Conexão com o Dropbox usando a variável de ambiente do Railway
const dbx = new Dropbox({ accessToken: process.env.DROPBOX_ACCESS_TOKEN });
const VAULT_ROOT = '/Brain'; // Alinha direto com a pasta do seu Obsidian

// Inicializa o servidor MCP
const mcpServer = new Server({
  name: "obsidian-dropbox",
  version: "1.0.0"
}, {
  capabilities: { tools: {} }
});

// Define as ferramentas que o Claude vai enxergar no celular
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ler_nota",
      description: "Lê o conteúdo de uma nota específica (.md) no Obsidian.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Caminho relativo da nota partindo da raiz (ex: /Projetos/Ideias.md)" }
        },
        required: ["path"]
      }
    },
    {
      name: "escrever_nota",
      description: "Cria ou sobrescreve uma nota (.md) com um conteúdo específico.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Caminho relativo da nota (ex: /Notas/Diario.md)" },
          conteudo: { type: "string", description: "Conteúdo em Markdown que será escrito" }
        },
        required: ["path", "conteudo"]
      }
    }
  ]
}));

// Executa os comandos enviados pelo Claude
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
      content: [{ type: "text", text: `Erro no Dropbox: ${error.message || JSON.stringify(error)}` }]
    };
  }
});

let sseTransport;

// CORREÇÃO AQUI: Escutando direto na raiz (/) para o Claude aceitar a URL limpa
app.get("/", async (req, res) => {
  sseTransport = new SSEServerTransport("/messages", res);
  await mcpServer.connect(sseTransport);
});

app.post("/messages", async (req, res) => {
  if (sseTransport) {
    await sseTransport.handlePostMessage(req, res);
  } else {
    res.status(400).send("Nenhum transporte SSE ativo.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor MCP rodando na porta ${PORT}`);
});