# Scraping API (Express + Puppeteer Stealth)

This repository provides two endpoints:
- `POST /extract` — extracts structured content (title, meta, headings, paragraphs, spans, buttons, features) from a given URL, bypassing Cloudflare/bot detection.
- `POST /screenshot` — captures a full-page PNG screenshot for a given URL and returns a base64 data URI.

This guide explains how to install and run this API on a CentOS server using PM2.

## Prerequisites
- A CentOS server (CentOS 7/8/Stream)
- `sudo` privileges
- Open network access on the port you plan to use (default `3000`)

## 1) Install Node.js (Recommended: Node 18 LTS)

Using NodeSource RPMs:

```
sudo yum install -y curl
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo -E bash -
sudo yum install -y nodejs
node -v
npm -v
```

## 2) Install Puppeteer/Chromium Dependencies
Headless Chromium requires some system libraries. Install common dependencies:

```
sudo yum install -y \
  libX11 libXcomposite libXcursor libXdamage libXext libXi libXtst \
  cups-libs libXrandr pango atk cairo nss alsa-lib \
  libdrm mesa-libgbm fontconfig libXScrnSaver
```

If you see missing library errors, install the indicated packages via `yum` and re-run.

## 3) Get the App Files on the Server
Upload the files or clone from your repository. Example using `scp` from your local machine:

```
# On your local machine
scp -r /path/to/scrapingapi/ user@your-server:/opt/scrapingapi
```

Or create directory and copy manually:

```
sudo mkdir -p /opt/scrapingapi
sudo chown $USER:$USER /opt/scrapingapi
cd /opt/scrapingapi
# Copy server.js, package.json, package-lock.json into this folder
```

## 4) Install Project Dependencies

```
cd /opt/scrapingapi
npm install
```

## 5) Run with PM2 (Process Manager)
Install PM2 globally and start the app:

```
sudo npm install -g pm2
cd /opt/scrapingapi
# Optional: customize port
export PORT=3000
pm2 start server.js --name scrapingapi --time
```

- `--name scrapingapi` sets a friendly name.
- `--time` adds timestamps to logs.

Enable PM2 startup on boot (systemd):

```
pm2 startup systemd
# PM2 will output a command; copy and run it, e.g.:
# sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u <your-user> --hp /home/<your-user>
pm2 save
```

Optional: PM2 log rotation:

```
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 30
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat 'YYYY-MM-DD_HH-mm-ss'
```

## 6) Open Firewall Port (If Needed)

If firewalld is enabled, allow inbound traffic to your port:

```
sudo firewall-cmd --add-port=3000/tcp --permanent
sudo firewall-cmd --reload
```

## 7) Verify the API

Check health:

```
curl -s http://localhost:3000/health
```

Test extract:

```
curl -s -X POST http://localhost:3000/extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://guessthetest.com/"}' | jq '.'
```

Test screenshot (returns base64 data URI):

```
curl -s -X POST http://localhost:3000/screenshot \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://guessthetest.com/"}' | jq -r '.screenshot | (.!=null) as $ok | if $ok then (.|length) else "ERROR" end'
```

## PM2 Management Cheatsheet

- List processes: `pm2 list`
- View logs: `pm2 logs scrapingapi`
- Monitor: `pm2 monit`
- Restart: `pm2 restart scrapingapi`
- Stop: `pm2 stop scrapingapi`
- Start on boot: `pm2 startup systemd` then `pm2 save`

## Environment & Configuration

- Port: set with `PORT` env var. Defaults to `3000`.
  - Example: `PORT=8080 pm2 start server.js --name scrapingapi`
- CORS: the API allows cross-origin requests by default.
- Puppeteer flags: the server already uses `--no-sandbox` and related flags for stability on Linux.

## Updating the App

From `/opt/scrapingapi`:

```
pm2 stop scrapingapi
# Update files (git pull or copy new files)
npm install
pm2 restart scrapingapi
pm2 save
```

## Troubleshooting

- Missing libraries: Install the library shown in the error via `yum`.
- Timeout errors: The server has generous timeouts, but slow or blocked sites may still time out. Try again or use a proxy.
- SELinux: If enforcing, ensure the port is allowed or configure a reverse proxy (Nginx) on standard ports.
- Memory/CPU limits: Adjust PM2 settings or system resources if handling high traffic.

## Security Notes

- The API is open by default. If exposing publicly, consider:
  - Adding authentication/rate limiting
  - Placing behind Nginx with TLS
  - Restricting allowed origins via CORS if needed



  ## command that we need to run on centos to use crome 
  sudo dnf install -y \
  alsa-lib \
  atk \
  at-spi2-atk \
  cups-libs \
  gtk3 \
  libXcomposite \
  libXcursor \
  libXdamage \
  libXext \
  libXi \
  libXrandr \
  libXScrnSaver \
  libXtst \
  pango \
  xorg-x11-fonts-misc \
  nss \
  libdrm \
  mesa-libgbm \
  libgbm \
  libxshmfence