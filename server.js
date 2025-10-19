const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: '*',
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Helper: content extraction matching your axios+cheerio logic
function extractContent(html, url) {
  const $ = cheerio.load(html);

  // Remove script/style and common non-content elements
  $('script, style, footer, header, aside, .advertisement, .ads, .cookie-banner').remove();

  const title = $('title').text().trim() || $('h1').first().text().trim() || 'No title found';

  const metaDescription =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';

  const headings = {
    h1: $('h1')
      .map((i, el) => $(el).text().trim())
      .get()
      .filter((text) => text.length > 0),
    h2: $('h2')
      .map((i, el) => $(el).text().trim())
      .get()
      .filter((text) => text.length > 0),
    h3: $('h3')
      .map((i, el) => $(el).text().trim())
      .get()
      .filter((text) => text.length > 0),
    h4: $('h4')
      .map((i, el) => $(el).text().trim())
      .get()
      .filter((text) => text.length > 0),
    h5: $('h5')
      .map((i, el) => $(el).text().trim())
      .get()
      .filter((text) => text.length > 0),
    h6: $('h6')
      .map((i, el) => $(el).text().trim())
      .get()
      .filter((text) => text.length > 0),
  };

  const paragraphs = $('p')
    .map((i, el) => $(el).text().trim())
    .get()
    .filter((text) => {
      if (text.length < 30 || text.length > 500) return false;
      const alphaRatio = (text.match(/[a-zA-Z]/g) || []).length / text.length;
      if (alphaRatio < 0.5) return false;
      const lowerText = text.toLowerCase();
      const skipPatterns = [
        'copyright',
        '©',
        'all rights reserved',
        'privacy policy',
        'terms of service',
        'cookie policy',
        'follow us',
        'subscribe',
      ];
      return !skipPatterns.some((pattern) => lowerText.includes(pattern));
    })
    .slice(0, 10);

  const spans = $('span')
    .map((i, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 10)
    .slice(0, 15);

  const buttons = $('button, a, input[type="submit"], .btn, .button')
    .map((i, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href');
      return { text, href };
    })
    .get()
    .filter((item) => item.text.length > 0);

  const features = $('ul li, ol li')
    .map((i, el) => $(el).text().trim())
    .get()
    .filter((text) => text.length > 0);

  return {
    url,
    title,
    metaDescription,
    headings,
    paragraphs,
    spans,
    buttons,
    features,
    extractedAt: new Date().toISOString(),
  };
}

// POST /extract — uses Puppeteer with stealth to bypass Cloudflare/bot checks
app.post('/extract', async (req, res) => {
  try {
    const { url } = req.body || {};

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1366,768',
      ],
      defaultViewport: { width: 1366, height: 768 },
    });

    const page = await browser.newPage();

    // Realistic user agent and headers
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    await page.setUserAgent(userAgent);
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });

    // Navigate and wait for Cloudflare/anti-bot interstitials to clear
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for body to be present and non-empty
    await page.waitForSelector('body', { timeout: 30000 });

    // Common Cloudflare/anti-bot messages — wait until they disappear
    try {
      await page.waitForFunction(
        () => {
          const txt = document.body.innerText || '';
          const title = document.title || '';
          const patterns = [
            /just a moment/i,
            /checking your browser/i,
            /attention required/i,
            /verify you are human/i,
            /access denied/i,
            /cloudflare/i,
          ];
          return !patterns.some((p) => p.test(txt) || p.test(title));
        },
        { timeout: 45000 }
      );
    } catch (e) {
      // If challenge persists, give the page a bit more time
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Optional small wait to ensure dynamic content settles
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const html = await page.content();

    const extracted = extractContent(html, url);

    await browser.close();

    return res.json(extracted);
  } catch (error) {
    console.error('Content extraction error:', error);

    const message = (error && error.message) || '';

    if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(message)) {
      return res.status(400).json({ error: 'Unable to reach the website. Please check the URL.' });
    }

    if (/TimeoutError|ETIMEDOUT/i.test(message)) {
      return res.status(408).json({ error: 'Request timed out. The website took too long to respond.' });
    }

    return res.status(500).json({ error: 'Failed to extract content from the website.' });
  }
});

// OPTIONS preflight for /screenshot (explicit for clarity)
app.options('/screenshot', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.sendStatus(200);
});

// GET info endpoint for /screenshot
app.get('/screenshot', (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*' });
  return res.json({
    message: 'Screenshot API is running',
    usage: 'Send a POST request with {"url": "https://example.com"} to capture a screenshot',
    endpoints: {
      'POST /screenshot': 'Capture a full page screenshot of the provided URL',
    },
    cors: 'Enabled for cross-origin requests',
  });
});

// POST /screenshot — capture full page screenshot using stealth Puppeteer
app.post('/screenshot', async (req, res) => {
  try {
    const { url } = req.body || {};

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080',
      ],
      defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    });

    const page = await browser.newPage();

    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    await page.setUserAgent(userAgent);
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    await page.waitForSelector('body', { timeout: 30000 });

    try {
      await page.waitForFunction(
        () => {
          const txt = document.body.innerText || '';
          const title = document.title || '';
          const patterns = [
            /just a moment/i,
            /checking your browser/i,
            /attention required/i,
            /verify you are human/i,
            /access denied/i,
            /cloudflare/i,
          ];
          return !patterns.some((p) => p.test(txt) || p.test(title));
        },
        { timeout: 45000 }
      );
    } catch (e) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });

    await browser.close();

    const base64Screenshot = screenshotBuffer.toString('base64');

    res.set({ 'Access-Control-Allow-Origin': '*' });
    return res.json({
      success: true,
      screenshot: `data:image/png;base64,${base64Screenshot}`,
      url,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Screenshot error:', error);

    const message = (error && error.message) || '';

    if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(message)) {
      return res.status(400).json({ error: 'Unable to reach the website. Please check the URL.' });
    }

    if (/TimeoutError|ETIMEDOUT/i.test(message)) {
      return res.status(408).json({ error: 'Request timed out. The website took too long to respond.' });
    }

    return res.status(500).json({ error: 'Failed to capture screenshot' });
  }
});

app.listen(PORT, () => {
  console.log(`Scraping API running on http://localhost:${PORT}`);
});