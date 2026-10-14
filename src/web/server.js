import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbOps } from '../db/database.js';
import { runScraper, stopScraper } from '../scraper/engine.js';
import { proxyManager } from '../scraper/proxyManager.js';
import { targetManager } from '../scraper/targetManager.js';
import { initCronScheduler, getCronStatus } from '../cron/scheduler.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Is a scraper job currently running?
let isScraping = false;

// Initialize Cron Scheduler
initCronScheduler();

// API Endpoints

// 1. Overview market statistics + Cron & Proxy status + Headless setting
app.get('/api/stats', (req, res) => {
  try {
    dotenv.config({ override: true }); // Dynamic reload of .env
    const stats = dbOps.getMarketOverview();
    const cronStatus = getCronStatus();
    const activeProxies = proxyManager.getActiveProxies();
    const proxyConfig = proxyManager.getConfig();
    const proxyStatus = {
      enabled: proxyConfig.enabled || false,
      activeCount: activeProxies.length,
      current: proxyManager.getCurrentProxyOptions()?.details?.name || 'Direct Connection'
    };
    const headlessMode = process.env.HEADLESS || 'new';
    const targetConfig = targetManager.getConfig();

    res.json({
      success: true,
      data: stats,
      isScraping,
      cron: cronStatus,
      proxy: proxyStatus,
      headless: headlessMode,
      target: targetConfig
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Filtered & paginated listings
app.get('/api/listings', (req, res) => {
  try {
    const { model, status, priceTrend, search, sortBy, page, pageSize } = req.query;
    const result = dbOps.getListings({
      model,
      status,
      priceTrend,
      search,
      sortBy,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 12
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2b. Single listing detail with full price history & specs
app.get('/api/listings/:id', (req, res) => {
  try {
    const detail = dbOps.getListingDetail(req.params.id);
    if (!detail) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }
    res.json({ success: true, data: detail });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Price changes & drops
app.get('/api/price-changes', (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    const changes = dbOps.getRecentPriceChanges(limit);
    res.json({ success: true, data: changes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Scraper run logs
app.get('/api/runs', (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 25;
    const runs = dbOps.getRecentRuns(limit);
    res.json({ success: true, data: runs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4b. Clear scraper run logs
app.delete('/api/runs', (req, res) => {
  try {
    const info = dbOps.clearRuns();
    res.json({ success: true, message: 'All run logs cleared.', count: info.changes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Trigger scraper from UI
app.post('/api/scrape', async (req, res) => {
  if (isScraping) {
    return res.status(409).json({ success: false, message: 'A scrape job is already in progress.' });
  }

  dotenv.config({ override: true }); // Dynamic reload of .env before scrape
  const targetConfig = targetManager.getConfig();
  const defaultPages = parseInt(process.env.CRON_PAGES || '100', 10);
  const defaultHeadless = process.env.HEADLESS || 'new';
  const { pages = defaultPages, headless = defaultHeadless, make = targetConfig.make } = req.body || {};
  isScraping = true;

  res.json({
    success: true,
    message: `Scraper started for ${make} (Pages/Model: ${pages}, Mode: ${headless}) in background.`
  });

  // Run asynchronously
  (async () => {
    try {
      await runScraper({ make, maxPages: Number(pages), headless });
    } catch (err) {
      console.error('Background scrape failed:', err);
    } finally {
      isScraping = false;
    }
  })();
});

// 6. Stop active scraper from UI
app.post('/api/scrape/stop', async (req, res) => {
  if (!isScraping) {
    dbOps.cleanOrphanedRuns();
    return res.json({ success: true, message: 'No scraper is currently active.' });
  }

  try {
    await stopScraper();
    isScraping = false;
    dbOps.cleanOrphanedRuns();
    res.json({ success: true, message: 'Scraper stopped successfully.' });
  } catch (err) {
    isScraping = false;
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Automotive Market Tracker dashboard running at http://localhost:${PORT}`);
});
