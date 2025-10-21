const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const compression = require('compression');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());

app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

    // Wait for body to be present and non-empty
    await page.waitForSelector('body', { timeout: 60000 });

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
        { timeout: 60000 }
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

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

    await page.waitForSelector('body', { timeout: 60000 });

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
        { timeout: 60000 }
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

// Helper functions for /colors (ported from oldapicode.js logic, JS-only)
function extractCSSVariables(cssText) {
  const variables = {};
  const variableMatches = cssText.match(/--[\w-]+:\s*[^;\}]+/g) || [];
  variableMatches.forEach((match) => {
    const parts = match.split(':');
    const name = parts[0]?.trim();
    const value = parts.slice(1).join(':').trim();
    if (name && value) variables[name] = value;
  });
  return variables;
}

function resolveCSSVariables(colorValue, cssVariables) {
  let resolved = colorValue;
  const varMatches = colorValue.match(/var\(([^)]+)\)/g) || [];
  varMatches.forEach((varMatch) => {
    const varNameMatch = varMatch.match(/var\(([^,)]+)/);
    const varName = varNameMatch && varNameMatch[1] ? varNameMatch[1].trim() : null;
    if (varName && cssVariables[varName]) {
      resolved = resolved.replace(varMatch, cssVariables[varName]);
    }
  });
  return resolved;
}

function extractColorsFromCSS(cssText, cssVariables = {}) {
  const colorMatches =
    cssText.match(/(#[0-9a-fA-F]{3,6}|rgb\([^)]+\)|rgba\([^)]+\)|hsl\([^)]+\)|hsla\([^)]+\))/g) || [];
  const resolvedColors = colorMatches.map((color) => {
    if (color.includes('var(')) {
      return resolveCSSVariables(color, cssVariables);
    }
    return color;
  });
  return resolvedColors.filter((color) => !color.includes('var('));
}

function extractCTAColors($, cssContent) {
  const ctaColors = [];
  const cssVariables = extractCSSVariables(cssContent);
  const ctaSelectors = [
    'button',
    'input[type="button"]',
    'input[type="submit"]',
    'a[href]',
    '.btn',
    '.button',
    '.cta',
    '.call-to-action',
    '.primary-btn',
    '.secondary-btn',
    '.action-btn',
  ];

  ctaSelectors.forEach((selector) => {
    $(selector).each((_, element) => {
      const $element = $(element);
      const style = $element.attr('style') || '';
      ctaColors.push(...extractColorsFromCSS(style, cssVariables));

      const classes = $element.attr('class');
      if (classes && cssContent) {
        const classNames = classes.split(' ').filter(Boolean);
        classNames.forEach((className) => {
          const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const classRegex = new RegExp(`\\.${escapedClassName}\\s*\\{[^}]*\\}`, 'gi');
          const classMatches = cssContent.match(classRegex);
          if (classMatches) {
            classMatches.forEach((match) => {
              ctaColors.push(...extractColorsFromCSS(match, cssVariables));
            });
          }
        });
      }

      const tagName = ($element.prop('tagName') || '').toLowerCase();
      if (tagName && cssContent) {
        const tagRegex = new RegExp(`${tagName}\\s*\\{[^}]*\\}`, 'gi');
        const tagMatches = cssContent.match(tagRegex);
        if (tagMatches) {
          tagMatches.forEach((match) => {
            ctaColors.push(...extractColorsFromCSS(match, cssVariables));
          });
        }
      }
    });
  });

  return ctaColors;
}

// POST /colors — replicate oldapicode.js logic via fetch + cheerio
app.post('/colors', async (req, res) => {
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let html = '';
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          Referer: new URL(url).origin,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        clearTimeout(timeoutId);
        return res.status(response.status).json({ error: `Failed to fetch website - Status ${response.status}` });
      }
      html = await response.text();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error && error.name === 'AbortError') {
        console.error('[Fetch Timeout] Request aborted after 15s');
        return res.status(504).json({ error: 'Request timed out' });
      }
      console.error('[Fetch Error]', error);
      return res.status(500).json({ error: 'Failed to fetch website' });
    }

    const $ = cheerio.load(html);
    let allCssContent = '';
    const htmlColors = [];

    // Collect images from HTML and inline styles
    const allImages = [];
    $('img').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (!src) return;
      let abs;
      if (src.startsWith('//')) abs = `https:${src}`;
      else if (src.startsWith('/')) abs = new URL(src, url).toString();
      else if (!src.startsWith('http') && !src.startsWith('data:')) abs = new URL(src, url).toString();
      else abs = src;
      if (abs && !abs.startsWith('data:') && !abs.includes('base64')) {
        allImages.push(abs);
      }
    });

    // Inline style background images in HTML
    const backgroundImageMatches =
      html.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/gi) || [];
    backgroundImageMatches.forEach((bg) => {
      const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (m) {
        const u = m[1];
        let abs;
        if (u.startsWith('//')) abs = `https:${u}`;
        else if (u.startsWith('/')) abs = new URL(u, url).toString();
        else if (!u.startsWith('http') && !u.startsWith('data:')) abs = new URL(u, url).toString();
        else abs = u;
        if (abs && !abs.startsWith('data:') && !abs.includes('base64')) {
          allImages.push(abs);
        }
      }
    });

    // Inline <style> blocks
    $('style').each((_, el) => {
      allCssContent += ($(el).html() || '') + '\n';
    });

    const initialCssVariables = extractCSSVariables(allCssContent);

    const extractHtmlColors = (vars) => {
      const colors = [];
      $('[style]').each((_, el) => {
        colors.push(...extractColorsFromCSS($(el).attr('style') || '', vars));
      });
      $('style').each((_, el) => {
        colors.push(...extractColorsFromCSS($(el).html() || '', vars));
      });
      return colors;
    };

    htmlColors.push(...extractHtmlColors(initialCssVariables));

    // External CSS links
    const cssLinks = [];
    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) {
        try {
          cssLinks.push(new URL(href, url).toString());
        } catch {}
      }
    });

    const cssColors = [];
    const limitedCssLinks = cssLinks.slice(0, 5);

    // Collect external CSS content (first pass, parallel)
    const cssContentByUrl = {};
    await Promise.all(
      limitedCssLinks.map(async (cssUrl) => {
        try {
          const cssResponse = await fetch(cssUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              'Accept-Encoding': 'gzip, deflate, br',
            },
            signal: AbortSignal.timeout(10000),
          });
          if (cssResponse.ok) {
            const cssContent = await cssResponse.text();
            cssContentByUrl[cssUrl] = cssContent;
          }
        } catch (e) {
          console.warn(`Failed CSS fetch ${cssUrl}`);
        }
      })
    );
    allCssContent += limitedCssLinks.map((u) => cssContentByUrl[u] || '').join('\n');

    const updatedCssVariables = extractCSSVariables(allCssContent);

    // Second pass: extract colors from external CSS using updated variables (reuse first-pass content)
    for (const cssUrl of limitedCssLinks) {
      const cssContent = cssContentByUrl[cssUrl];
      if (!cssContent) continue;
      cssColors.push(...extractColorsFromCSS(cssContent, updatedCssVariables));

      // Extract images from CSS background-image URLs
      const cssBackgroundImages = cssContent.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/gi) || [];
      cssBackgroundImages.forEach((bg) => {
        const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (m) {
          const u = m[1];
          let abs;
          if (u.startsWith('//')) abs = `https:${u}`;
          else if (u.startsWith('/')) abs = new URL(u, cssUrl).toString();
          else if (!u.startsWith('http') && !u.startsWith('data:')) abs = new URL(u, cssUrl).toString();
          else abs = u;
          if (abs && !abs.startsWith('data:') && !abs.includes('base64')) {
            allImages.push(abs);
          }
        }
      });
    }

    // Re-extract HTML colors with updated variables
    htmlColors.length = 0;
    htmlColors.push(...extractHtmlColors(updatedCssVariables));

    // CTA colors
    const ctaColors = extractCTAColors($, allCssContent);

    // Filter and process
    const filterColors = (colors) =>
      colors
        .filter(
          (c) =>
            ![
              '#000',
              '#000000',
              'black',
              '#fff',
              '#ffffff',
              'white',
              'transparent',
              'inherit',
              'initial',
              'unset',
            ].includes((c || '').toLowerCase().trim()),
        )
        .map((c) => (c || '').trim())
        .filter((c, i, arr) => arr.indexOf(c) === i);

    const processedCtaColors = filterColors(ctaColors).slice(0, 3);
    const generalColors = [...htmlColors, ...cssColors].filter((c) => !ctaColors.includes(c));
    const processedGeneralColors = filterColors(generalColors).slice(0, 8);

    const finalGeneralColors =
      processedGeneralColors.length > 0
        ? processedGeneralColors
        : ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4'];

    const allProcessedColors = [...processedCtaColors, ...finalGeneralColors].slice(0, 8);

    const title = $('title').text().trim() || '';
    const metaDescription = $('meta[name="description"]').attr('content') || '';

    // Process and deduplicate images
    const processedImages = allImages
      .filter((img) => {
        const excludePatterns = [
          /\.(ico|favicon)$/i,
          /1x1\./,
          /pixel\./,
          /tracking/i,
          /analytics/i,
          /\b\d+x\d+\b/,
        ];
        return !excludePatterns.some((p) => p.test(img));
      })
      .filter((img) => {
        const baseUrlOnly = img.split('?')[0];
        return /\.(jpg|jpeg|png|webp|svg)(\?|$)/i.test(baseUrlOnly);
      });

    const uniqueImages = [...new Set(processedImages)].slice(0, 20);

    return res.json({
      success: true,
      colors: allProcessedColors,
      ctaColors: processedCtaColors,
      generalColors: finalGeneralColors,
      images: uniqueImages,
      metadata: { title, description: metaDescription, url },
    });
  } catch (error) {
    console.error('Error extracting colors:', error);
    return res.status(500).json({ error: 'Failed to extract colors' });
  }
});

// OPTIONS preflight for /website-data
app.options('/website-data', (_req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  return res.sendStatus(204);
});

// GET info for /website-data
app.get('/website-data', (_req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*' });
  return res.json({
    endpoint: 'POST /website-data',
    input: { body: { url: 'https://...' } },
    returns: ['colors', 'ctaColors', 'generalColors', 'images', 'fonts', 'headings', 'paragraphs', 'metadata'],
    note: 'Send a JSON body with {url}. Full CORS enabled.',
  });
});

// POST /website-data — consolidated extraction (colors, images, fonts, headings, paragraphs)
app.post('/website-data', async (req, res) => {
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let html = '';
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          Referer: new URL(url).origin,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        clearTimeout(timeoutId);
        return res.status(response.status).json({ error: `Failed to fetch website - Status ${response.status}` });
      }
      html = await response.text();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error && error.name === 'AbortError') {
        console.error('[Fetch Timeout] Request aborted after 15s');
        return res.status(504).json({ error: 'Request timed out' });
      }
      console.error('[Fetch Error]', error);
      return res.status(500).json({ error: 'Failed to fetch website' });
    }

    const $ = cheerio.load(html);
    let allCssContent = '';
    const htmlColors = [];

    // Collect images from HTML and inline styles
    const allImages = [];
    $('img').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (!src) return;
      let abs;
      if (src.startsWith('//')) abs = `https:${src}`;
      else if (src.startsWith('/')) abs = new URL(src, url).toString();
      else if (!src.startsWith('http') && !src.startsWith('data:')) abs = new URL(src, url).toString();
      else abs = src;
      if (abs && !abs.startsWith('data:') && !abs.includes('base64')) {
        allImages.push(abs);
      }
    });

    const backgroundImageMatches =
      html.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/gi) || [];
    backgroundImageMatches.forEach((bg) => {
      const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (m) {
        const u = m[1];
        let abs;
        if (u.startsWith('//')) abs = `https:${u}`;
        else if (u.startsWith('/')) abs = new URL(u, url).toString();
        else if (!u.startsWith('http') && !u.startsWith('data:')) abs = new URL(u, url).toString();
        else abs = u;
        if (abs && !abs.startsWith('data:') && !abs.includes('base64')) {
          allImages.push(abs);
        }
      }
    });

    // Inline <style> blocks
    $('style').each((_, el) => {
      allCssContent += ($(el).html() || '') + '\n';
    });

    const initialCssVariables = extractCSSVariables(allCssContent);

    const extractHtmlColors = (vars) => {
      const colors = [];
      $('[style]').each((_, el) => {
        colors.push(...extractColorsFromCSS($(el).attr('style') || '', vars));
      });
      $('style').each((_, el) => {
        colors.push(...extractColorsFromCSS($(el).html() || '', vars));
      });
      return colors;
    };

    htmlColors.push(...extractHtmlColors(initialCssVariables));

    // External CSS links
    const cssLinks = [];
    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) {
        try {
          cssLinks.push(new URL(href, url).toString());
        } catch {}
      }
    });

    const cssColors = [];
    const limitedCssLinks = cssLinks.slice(0, 5);

    // Collect external CSS content (first pass, parallel)
    const cssContentByUrl = {};
    await Promise.all(
      limitedCssLinks.map(async (cssUrl) => {
        try {
          const cssResponse = await fetch(cssUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              'Accept-Encoding': 'gzip, deflate, br',
            },
            signal: AbortSignal.timeout(10000),
          });
          if (cssResponse.ok) {
            const cssContent = await cssResponse.text();
            cssContentByUrl[cssUrl] = cssContent;
          }
        } catch (e) {
          console.warn(`Failed CSS fetch ${cssUrl}`);
        }
      })
    );
    allCssContent += limitedCssLinks.map((u) => cssContentByUrl[u] || '').join('\n');

    const updatedCssVariables = extractCSSVariables(allCssContent);

    // Second pass: extract colors from external CSS using updated variables (reuse first-pass content)
    for (const cssUrl of limitedCssLinks) {
      const cssContent = cssContentByUrl[cssUrl];
      if (!cssContent) continue;
      cssColors.push(...extractColorsFromCSS(cssContent, updatedCssVariables));

      // Extract images from CSS background-image URLs
      const cssBackgroundImages = cssContent.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/gi) || [];
      cssBackgroundImages.forEach((bg) => {
        const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (m) {
          const u = m[1];
          let abs;
          if (u.startsWith('//')) abs = `https:${u}`;
          else if (u.startsWith('/')) abs = new URL(u, cssUrl).toString();
          else if (!u.startsWith('http') && !u.startsWith('data:')) abs = new URL(u, cssUrl).toString();
          else abs = u;
          if (abs && !abs.startsWith('data:') && !abs.includes('base64')) {
            allImages.push(abs);
          }
        }
      });
    }

    // Re-extract HTML colors with updated variables
    htmlColors.length = 0;
    htmlColors.push(...extractHtmlColors(updatedCssVariables));

    // CTA colors
    const ctaColors = extractCTAColors($, allCssContent);

    // Filter and process colors
    const filterColors = (colors) =>
      colors
        .filter(
          (c) =>
            ![
              '#000',
              '#000000',
              'black',
              '#fff',
              '#ffffff',
              'white',
              'transparent',
              'inherit',
              'initial',
              'unset',
            ].includes((c || '').toLowerCase().trim()),
        )
        .map((c) => (c || '').trim())
        .filter((c, i, arr) => arr.indexOf(c) === i);

    const processedCtaColors = filterColors(ctaColors).slice(0, 3);
    const generalColors = [...htmlColors, ...cssColors].filter((c) => !ctaColors.includes(c));
    const processedGeneralColors = filterColors(generalColors).slice(0, 8);

    const finalGeneralColors =
      processedGeneralColors.length > 0
        ? processedGeneralColors
        : ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4'];

    const allProcessedColors = [...processedCtaColors, ...finalGeneralColors].slice(0, 8);

    // Headings and paragraphs (samples)
    const headings = [];
    ['h1', 'h2', 'h3'].forEach((tag) => {
      $(tag)
        .map((i, el) => $(el).text().trim())
        .get()
        .filter((t) => t.length > 0 && t.length < 100)
        .slice(0, 1)
        .forEach((t) => headings.push(t));
    });

    const paragraphs = $('p')
      .map((i, el) => $(el).text().trim())
      .get()
      .filter((t) => t.length > 20 && t.length < 200)
      .slice(0, 3);

    // Fonts from HTML + CSS
    const collectFonts = (text) => {
      const matches = text.match(/font-family:\s*[^;\}]+/gi) || [];
      return matches
        .map((m) => m.split(':').slice(1).join(':').trim())
        .map((v) => v.replace(/["']/g, ''))
        .map((v) => v.split(',')[0].trim())
        .filter(Boolean);
    };

    const uniqueFonts = [...new Set([...collectFonts(html), ...collectFonts(allCssContent)])].slice(0, 3);

    // Metadata
    const title = $('title').text().trim() || '';
    const metaDescription = $('meta[name="description"]').attr('content') || '';

    // Process and deduplicate images
    const processedImages = allImages
      .filter((img) => {
        const excludePatterns = [/\.(ico|favicon)$/i, /1x1\./, /pixel\./, /tracking/i, /analytics/i, /\b\d+x\d+\b/];
        return !excludePatterns.some((p) => p.test(img));
      })
      .filter((img) => {
        const baseUrlOnly = img.split('?')[0];
        return /\.(jpg|jpeg|png|webp|svg)(\?|$)/i.test(baseUrlOnly);
      });

    const uniqueImages = [...new Set(processedImages)].slice(0, 20);

    res.set({ 'Access-Control-Allow-Origin': '*' });
    return res.json({
      success: true,
      colors: allProcessedColors,
      ctaColors: processedCtaColors,
      generalColors: finalGeneralColors,
      images: uniqueImages,
      fonts: uniqueFonts,
      headings,
      paragraphs,
      metadata: { title, description: metaDescription, url },
    });
  } catch (error) {
    console.error('Error extracting website data:', error);
    return res.status(500).json({ error: 'Failed to extract website data' });
  }
});

app.listen(PORT, () => {
  console.log(`Scraping API running on http://localhost:${PORT}`);
});