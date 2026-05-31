# Dropbox MCP Server

A remote MCP server that gives Claude full access to your Dropbox account —
list, read, write, move, copy, delete files and folders, search, and more.

---

## Files

```
dropbox-mcp/
├── server.py            ← the MCP server (deploy this)
├── requirements.txt     ← Python dependencies
├── Dockerfile           ← containerised deployment
├── get_refresh_token.py ← run once to get a long-lived token
└── README.md
```

---

## Step 1 — Get your Dropbox credentials

You need **at least one** of the following:

### Option A — Access token (quickest start)

1. Go to [https://www.dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) and open your app.
2. Under the **Settings** tab, scroll to **OAuth 2** → **Generated access token**.
3. Click **Generate** and copy the token.
4. Set `DROPBOX_ACCESS_TOKEN=<that token>` in your deployment.

> ⚠️ Since 2021 Dropbox generates **short-lived tokens** (4-hour expiry) by default.
> The server will stop working when the token expires.
> Use **Option B** for a permanent deployment.

---

### Option B — Refresh token (recommended for permanent use)

Run the helper script once on your local machine:

```bash
pip install dropbox
python get_refresh_token.py
```

Follow the prompts — it will print three env vars to set:

```
DROPBOX_APP_KEY=…
DROPBOX_APP_SECRET=…
DROPBOX_REFRESH_TOKEN=…
```

The refresh token never expires and the SDK rotates access tokens automatically.

---

## Step 2 — Deploy the server

Pick any platform. The server listens on `$PORT` (default **8000**) and exposes
the MCP endpoint at **`/mcp`**.

---

### Option A — Railway (recommended, free tier available)

1. Create a free account at [railway.app](https://railway.app).
2. New project → **Deploy from GitHub repo** (push this folder to a GitHub repo first),
   or use **Deploy from local** via the Railway CLI.
3. In the service's **Variables** tab, add your Dropbox env vars.
4. Railway auto-detects the `Dockerfile` and builds it.
5. Under **Settings → Networking**, enable a public domain.
6. Your MCP URL is: `https://<your-app>.railway.app/mcp`

---

### Option B — Render (free tier available)

1. Create a free account at [render.com](https://render.com).
2. New → **Web Service** → connect your GitHub repo.
3. Runtime: **Docker**.
4. Add Dropbox env vars in **Environment**.
5. Your MCP URL is: `https://<your-app>.onrender.com/mcp`

---

### Option C — Fly.io

```bash
# Install flyctl, then:
fly launch          # detects Dockerfile, follow prompts
fly secrets set DROPBOX_ACCESS_TOKEN=<token>   # or all three Option B vars
fly deploy
```

MCP URL: `https://<your-app>.fly.dev/mcp`

---

### Option D — Run locally (for testing only)

```bash
pip install -r requirements.txt
export DROPBOX_ACCESS_TOKEN=<token>   # or the three Option B vars
python server.py
```

MCP URL: `http://localhost:8000/mcp`

To expose it publicly for Claude (while testing), use [ngrok](https://ngrok.com):
```bash
ngrok http 8000
# use the https://…ngrok-free.app/mcp URL
```

---

## Step 3 — Add the connector to Claude

1. Open [claude.ai](https://claude.ai) → click your profile → **Settings**.
2. Select **Connectors** in the sidebar.
3. Scroll down → **Add custom connector**.
4. Enter your MCP URL (e.g. `https://your-app.railway.app/mcp`).
5. Click **Add** — no OAuth required, the server uses your embedded token.
6. The connector will appear as **dropbox** in your list.

---

## Available tools

| Tool | Description |
|---|---|
| `list_files` | List files/folders at a path (supports recursive) |
| `get_metadata` | Get size, dates, ID, rev for any file or folder |
| `read_file` | Download a file — text returned as-is, binary as base64 |
| `write_file` | Create or overwrite a text file |
| `create_folder` | Create a new folder |
| `delete` | Permanently delete a file or folder |
| `move` | Move a file or folder |
| `copy` | Copy a file or folder |
| `search` | Search files by name/content |
| `get_file_versions` | List version history for a file |
| `get_storage_info` | Show used/free/total storage |
| `get_account_info` | Show account name, email, plan |

---

## Security notes

- Your Dropbox token is stored as a server-side environment variable — it is
  never sent to Claude or Anthropic.
- All Dropbox actions are performed server-side on your behalf.
- Keep your deployment URL reasonably private (treat it like an API key).
- For extra protection, place the server behind a reverse proxy with IP
  allowlisting — Anthropic's outbound IPs are in the `160.79.104.0/21` block.
