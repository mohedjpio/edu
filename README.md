# SmartShare 🚀

Secure peer-to-peer sharing — chat, files, clipboard. No accounts, no cloud storage.

## Deploy in 2 minutes

### Railway (recommended — free tier available)
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)

```bash
# 1. Push to GitHub
git init && git add . && git commit -m "init"
gh repo create smartshare --public --push

# 2. Go to railway.app → New Project → Deploy from GitHub repo
# 3. Select your repo — Railway auto-detects everything
# Done! Your URL: https://smartshare-xxx.railway.app
```

Railway auto-injects `RAILWAY_PUBLIC_DOMAIN` — no env vars needed.

---

### Render (free tier)

```bash
# 1. Push to GitHub (same as above)
# 2. Go to render.com → New Web Service → Connect your repo
# 3. Build: npm install --production
# 4. Start: node server/index.js
# Done! Your URL: https://smartshare.onrender.com
```

Render auto-injects `RENDER_EXTERNAL_URL` — no env vars needed.

---

### Fly.io

```bash
npm install -g flyctl
flyctl auth login
flyctl launch        # detects Dockerfile automatically
flyctl deploy
```

---

### Heroku

```bash
heroku create smartshare
git push heroku main
```

---

### Any VPS / Custom Domain

```bash
# Set the env var so the QR code contains the right URL
export PUBLIC_URL=https://yourdomain.com
node server/index.js
```

---

## Local development

```bash
npm install
npm start
# Open http://localhost:3000
# Phone on same Wi-Fi: open http://YOUR_LAN_IP:3000
```

## How it works

1. Both peers connect to the signaling server (WebSocket)
2. Server relays SDP offer/answer + ICE candidates
3. WebRTC DataChannel opens directly between peers (P2P)
4. Server never sees your data — only routing metadata

## Security

- All WebRTC traffic: DTLS-encrypted (mandatory in all browsers)
- Session IDs: UUID v4 (unguessable)
- No data stored on server — everything lives in RAM and expires

## Environment variables

| Variable | Description | Auto-set by |
|---|---|---|
| `PORT` | Server port | All platforms |
| `PUBLIC_URL` | Override public URL | Manual |
| `RAILWAY_PUBLIC_DOMAIN` | Railway domain | Railway |
| `RENDER_EXTERNAL_URL` | Render URL | Render |
| `FLY_APP_NAME` | Fly app name | Fly.io |
| `HEROKU_APP_DEFAULT_DOMAIN_NAME` | Heroku domain | Heroku |
