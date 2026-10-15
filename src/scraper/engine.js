import { chromium } from 'patchright';
import dotenv from 'dotenv';
import { dbOps } from '../db/database.js';
import { parseCardFromText } from './parser.js';
import { proxyManager } from './proxyManager.js';
import { targetManager } from './targetManager.js';
import { initHumanMouse, solveCloudflareIfPresent } from './humanMouse.js';

let activeBrowser = null;
let activeAbort = false;

export async function stopScraper() {
  activeAbort = true;
  if (activeBrowser) {
    try {
      await activeBrowser.close();
    } catch (e) { }
    activeBrowser = null;
  }
}

export async function runScraper(options = {}) {
  activeAbort = false;
  dotenv.config({ override: true }); // Dynamic reload of .env
  const targetConfig = targetManager.getConfig();

  const make = options.make || targetConfig.make || 'Tesla';
  const postcode = options.postcode || targetConfig.postcode || 'SW1A 1AA';
  const maxPages = options.maxPages || targetConfig.maxPagesPerModel || 100;
  const headless = options.headless !== undefined ? options.headless : (process.env.HEADLESS ?? false);
  const channel = options.channel || 'chrome';

  // Determine headless mode: 'new' | true | false
  const rawHeadless = options.headless !== undefined ? options.headless : (process.env.HEADLESS ?? 'false');
  const normHeadless = String(rawHeadless).trim().toLowerCase();

  const REAL_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

  let isHeadless = false;
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-webrtc',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--enforce-webrtc-ip-permission-check',
    `--user-agent=${REAL_USER_AGENT}`
  ];
  let modeLabel = 'Headed (visible window)';

  if (normHeadless === 'new' || normHeadless === 'chrome-headless') {
    isHeadless = false;
    launchArgs.push('--headless=new');
    modeLabel = 'Chrome New Headless (--headless=new)';
  } else if (normHeadless === 'true' || normHeadless === '1') {
    isHeadless = true;
    modeLabel = 'Standard Headless';
  } else {
    isHeadless = false;
    modeLabel = 'Headed (visible window)';
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⚡ AutoTrader UK Market Intelligence Scraper ⚡');
  console.log(`Target: Make: ${make} | Postcode: ${postcode} | Max Pages/Model: ${maxPages}`);
  console.log(`🖥️ [Browser Mode] ${modeLabel}`);

  // Check Proxy Configuration
  const proxyInfo = proxyManager.getCurrentProxyOptions();
  if (proxyInfo) {
    console.log(`🛡️ [Proxy Active] [${proxyInfo.details.name || proxyInfo.details.type}] Server: ${proxyInfo.details.host}:${proxyInfo.details.port}`);
  } else {
    console.log('🌐 [Proxy Disabled] Using direct local connection.');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const runStartedAt = new Date().toISOString();
  const runId = dbOps.createScrapeRun();

  const launchOptions = {
    headless: isHeadless,
    channel,
    args: launchArgs
  };

  if (proxyInfo?.playwrightProxy) {
    launchOptions.proxy = proxyInfo.playwrightProxy;
  }

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (err) {
    console.warn('⚠️ Fallback to default browser:', err.message);
    const fallbackOpts = { headless: isHeadless, args: launchArgs };
    if (proxyInfo?.playwrightProxy) fallbackOpts.proxy = proxyInfo.playwrightProxy;
    browser = await chromium.launch(fallbackOpts);
  }
  activeBrowser = browser;

  // Determine concurrency (CLI flag > config/proxies.json > default: 4)
  let concurrency = options.workers || proxyManager.config?.concurrency || 4;
  if (proxyInfo?.details?.type === 'mobile_rotating' && concurrency > 1) {
    console.log('⚠️ [Notice] Mobile rotating proxy active. Restricting to 1 worker to prevent cellular modem reset conflicts.');
    concurrency = 1;
  }

  const stats = {
    total_listings_found: 0,
    new_listings_count: 0,
    price_changes_count: 0,
    sold_delisted_count: 0,
    status: 'completed',
    error_message: null
  };

  const seenIds = [];

  try {
    // 1. Establish initial session & discover active models for this make
    console.log(`🌐 Visiting AutoTrader to establish session & discover models for "${make}"...`);
    const sessionContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-GB',
      userAgent: REAL_USER_AGENT
    });
    const sessionPage = await sessionContext.newPage();
    await initHumanMouse(sessionPage);

    let targetModels = [];
    try {
      targetModels = await targetManager.discoverModels(sessionPage, make);
    } catch (sErr) {
      console.warn('⚠️ Model discovery notice:', sErr.message);
    } finally {
      await sessionContext.close().catch(() => { });
    }

    // 2. Build Shared Multi-Model Page Queue
    const queue = [];
    for (const m of targetModels) {
      const pagesForModel = Math.min(m.pages || maxPages, maxPages);
      for (let p = 1; p <= pagesForModel; p++) {
        queue.push({
          make,
          model: m.value,
          pageNum: p,
          totalPages: pagesForModel
        });
      }
    }

    const workerCount = Math.min(concurrency, queue.length || 1);
    console.log(`\n📦 [Multi-Model Queue] Built queue of ${queue.length} pages across ${targetModels.length} models for ${make}.`);
    console.log(`⚡ Launching ${workerCount} parallel workers (Concurrency: ${workerCount})...\n`);

    let completedCleanly = true;

    // Batch rotation interval (default: 5 pages per IP/context session)
    const rotationInterval = proxyManager.config?.rotationIntervalPages || 5;
    const isRotatingGateway = proxyInfo?.details?.type === 'ipv6_rotating';

    async function runWorker(workerId) {
      let context = null;
      let page = null;
      let pagesInCurrentBatch = 0;

      async function createWorkerContext() {
        if (context) {
          await context.close().catch(() => { });
        }
        context = await browser.newContext({
          viewport: { width: 1366, height: 768 },
          locale: 'en-GB',
          userAgent: REAL_USER_AGENT
        });
        page = await context.newPage();
        await initHumanMouse(page);
        pagesInCurrentBatch = 0;
      }

      await createWorkerContext();

      try {
        while (queue.length > 0) {
          if (activeAbort) {
            console.log(`🛑 [Worker ${workerId}] Stop signal received, exiting queue.`);
            break;
          }

          const task = queue.shift();
          if (!task) break;

          const { make, model, pageNum, totalPages } = task;

          // Ensure page and context are healthy
          if (!page || page.isClosed()) {
            await createWorkerContext();
          }

          try {
            const encodedPostcode = encodeURIComponent(postcode);
            const searchUrl = `https://www.autotrader.co.uk/car-search?channel=cars&postcode=${encodedPostcode}&make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&page=${pageNum}`;
            let rawCards = [];
            let pageSuccess = false;
            let modelReachedEnd = false;
            const maxRetries = 3;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
              if (activeAbort) break;

              if (!page || page.isClosed()) {
                await createWorkerContext();
              }

              try {
                if (attempt === 1) {
                  const batchNote = isRotatingGateway ? ` (Batch ${pagesInCurrentBatch + 1}/${rotationInterval})` : '';
                  console.log(`📄 [Worker ${workerId} | ${model} | Page ${pageNum}/${totalPages}] Fetching${batchNote}...`);
                } else {
                  console.log(`🔄 [Worker ${workerId} | ${model} | Page ${pageNum}] (Attempt ${attempt}/${maxRetries}) Retrying...`);
                  await page.waitForTimeout(3000);
                }

                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 50000 });

                const cfSolvedInitial = await solveCloudflareIfPresent(page);
                if (cfSolvedInitial) {
                  console.log(`🔄 [Worker ${workerId}] Cloudflare solved on load! Giving extra time for listings to render...`);
                  await page.waitForTimeout(3000);
                }

                let listingsReady = false;
                const waitStartTime = Date.now();
                const maxWaitMs = 25000;
                let refreshClicked = false;

                while (Date.now() - waitStartTime < maxWaitMs) {
                  if (activeAbort) break;

                  // 1. Check if car listings are attached
                  const linkCount = await page.locator('a[href*="/car-details/"]').count().catch(() => 0);
                  if (linkCount > 0) {
                    listingsReady = true;
                    break;
                  }

                  // 2. Check for AutoTrader error screen with "Refresh page" button
                  const errorBtn = page.locator('button:has-text("Refresh page"), button:has-text("Refresh")').first();
                  const hasErrorBtn = await errorBtn.isVisible().catch(() => false);
                  if (hasErrorBtn) {
                    if (!refreshClicked) {
                      refreshClicked = true;
                      console.log(`🔄 [Worker ${workerId} | ${model} | Page ${pageNum}] AutoTrader error detected ("Refresh page"). Clicking button...`);
                      await errorBtn.click().catch(() => { });
                      await page.waitForTimeout(3000);
                      continue;
                    } else {
                      console.log(`🔄 [Worker ${workerId} | ${model} | Page ${pageNum}] Error persists after button click. Reloading page...`);
                      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
                      await page.waitForTimeout(2000);
                      continue;
                    }
                  }

                  // 3. Check for Cloudflare challenge
                  const cfSolved = await solveCloudflareIfPresent(page);
                  if (cfSolved) {
                    console.log(`🔄 [Worker ${workerId}] Cloudflare solved during wait! Giving time for search results...`);
                    await page.waitForTimeout(3000);
                    continue;
                  }

                  // 4. Check if AutoTrader 100-page limit reached OR genuine 0 results
                  const pageState = await page.evaluate(() => {
                    const headingEl = document.querySelector('[data-testid="search-results-heading"], h1, [data-gui="search-results-title"]');
                    const headingText = headingEl ? headingEl.innerText : '';
                    const mainEl = document.querySelector('main') || document.body;
                    const mainText = mainEl ? mainEl.innerText : '';

                    const isMax = mainText.includes('Maximum displayed results reached');
                    const hasZero = /0\s+(results|vehicles)\b/i.test(headingText) ||
                      headingText.includes('No results') ||
                      mainText.includes('There are no matching results') ||
                      mainText.includes('No results found for');
                    return { isMax, isZero: hasZero };
                  }).catch(() => ({ isMax: false, isZero: false }));

                  if (pageState.isMax) {
                    console.log(`🏁 [Worker ${workerId} | ${model}] AutoTrader 100-page limit reached. Concluding ${model}.`);
                    modelReachedEnd = true;
                    for (let i = queue.length - 1; i >= 0; i--) {
                      if (queue[i].model === model) queue.splice(i, 1);
                    }
                    pageSuccess = true;
                    rawCards = [];
                    break;
                  }

                  if (attempt === maxRetries && pageState.isZero && pageNum > 1) {
                    console.log(`ℹ️ [Worker ${workerId} | ${model}] Reached genuine end of listings for ${model} on page ${pageNum}.`);
                    modelReachedEnd = true;
                    for (let i = queue.length - 1; i >= 0; i--) {
                      if (queue[i].model === model) queue.splice(i, 1);
                    }
                    pageSuccess = true;
                    rawCards = [];
                    break;
                  }

                  await page.waitForTimeout(1500);
                }

                if (modelReachedEnd) {
                  break;
                }

                if (!listingsReady) {
                  throw new Error(`Timeout waiting for listings (waited ${Math.round((Date.now() - waitStartTime) / 1000)}s)`);
                }

                await page.waitForTimeout(1000);

                const extractCards = async () => page.evaluate(() => {
                  const items = [];
                  const seen = new Set();
                  const links = document.querySelectorAll('a[href*="/car-details/"]');
                  links.forEach(a => {
                    const href = a.getAttribute('href') || '';
                    const match = href.match(/\/car-details\/(\d+)/);
                    if (!match) return;
                    const id = match[1];
                    if (seen.has(id)) return;
                    seen.add(id);
                    const container = a.closest('li') || a.closest('[data-testid^="advertCard"]') || a.closest('article') || a.parentElement;
                    items.push({ id, text: container ? container.innerText : '', link: href, img: container?.querySelector('img[src*="autotrader"], img')?.getAttribute('src') });
                  });
                  return items;
                });

                rawCards = await extractCards();
                if (rawCards.length === 0) {
                  await page.waitForTimeout(2000);
                  rawCards = await extractCards();
                }

                if (rawCards.length > 0 || modelReachedEnd) {
                  pageSuccess = true;
                  break;
                } else {
                  throw new Error('Page loaded but 0 cards extracted.');
                }
              } catch (err) {
                console.warn(`⚠️ [Worker ${workerId} | ${model} | Page ${pageNum}] Attempt ${attempt} failed: ${err.message}`);
                if (attempt === maxRetries) {
                  await page.screenshot({ path: `screenshots/error_worker${workerId}_page${pageNum}.png` }).catch(() => { });
                }
              }
            }

            if (!pageSuccess && !modelReachedEnd) {
              const requeueAttempts = task.requeueAttempts || 0;
              const maxRequeues = 1; // Limit: Allow at most 1 requeue per page to prevent infinite loops

              if (requeueAttempts < maxRequeues) {
                task.requeueAttempts = requeueAttempts + 1;
                console.warn(`🔁 [Worker ${workerId} | ${model} | Page ${pageNum}] Failed after ${maxRetries} attempts. Re-queuing to the back of the queue (Re-try ${task.requeueAttempts}/${maxRequeues}).`);
                queue.push(task);
              } else {
                console.error(`❌ [Worker ${workerId} | ${model} | Page ${pageNum}] Permanently failed after retry and re-queue limit reached.`);
                completedCleanly = false;
              }
              continue;
            }

            let newOnPage = 0;
            for (const raw of rawCards) {
              const car = parseCardFromText(raw.id, raw.text, raw.link, raw.img, model, make);
              if (!car) continue;

              stats.total_listings_found++;
              seenIds.push(car.id);

              const existing = dbOps.getListingById(car.id);
              if (!existing) {
                dbOps.insertListing(car);
                stats.new_listings_count++;
                newOnPage++;
              } else {
                if (existing.price !== car.price) {
                  stats.price_changes_count++;
                }
                dbOps.updateListing(car.id, { price: car.price, oldPrice: existing.price });
              }
            }

            console.log(`✅ [Worker ${workerId} | ${model} | Page ${pageNum}] Done. Found ${rawCards.length} cars (${newOnPage} new). [Queue left: ${queue.length} pages]`);

            pagesInCurrentBatch++;

            // IPv6 Rotating Gateway: Cycle context every N pages to obtain fresh IPv6
            if (isRotatingGateway && pagesInCurrentBatch >= rotationInterval) {
              console.log(`\n🔄 [Worker ${workerId}] Batch of ${pagesInCurrentBatch} pages completed. Renewing context for fresh IPv6...`);
              await createWorkerContext();
            }

            // Mobile proxy rotation check if running single worker with mobile
            if (proxyInfo?.details?.type === 'mobile_rotating' && (pageNum % rotationInterval === 0)) {
              console.log(`\n📦 [Batch Completed] ${pageNum} pages scraped. Executing mobile proxy rotation with cooldown check...`);
              await proxyManager.rotateMobileIp(proxyInfo.details);
            }
          } finally {
            // Keep context alive for next page in batch
          }

          await new Promise(r => setTimeout(r, Math.floor(Math.random() * 500) + 500));
        }
      } finally {
        if (context) {
          await context.close().catch(() => { });
        }
      }
    }

    // Launch all workers concurrently
    const workerPromises = [];
    for (let w = 1; w <= workerCount; w++) {
      workerPromises.push(runWorker(w));
    }

    await Promise.all(workerPromises);

    // 3. Precision verification of unscraped active listings directly via in-page fetch
    const uniqueSeenIds = new Set(seenIds);
    stats.total_listings_found = uniqueSeenIds.size;

    if (completedCleanly && queue.length === 0 && !activeAbort) {
      const activeListings = dbOps.getActiveListings(make);
      const candidatesToVerify = activeListings.filter(car => !uniqueSeenIds.has(car.id));

      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📋 [İlan Kontrol Ön Raporu]`);
      console.log(`   • Veritabanındaki kayıtlı aktif ilan sayısı: ${activeListings.length}`);
      console.log(`   • Bu taramada arama sayfalarında bulunan ilan sayısı: ${uniqueSeenIds.size}`);
      console.log(`   • Sayfalarda bulunamayan ve kontrol edilecek ilan sayısı: ${candidatesToVerify.length}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      if (candidatesToVerify.length > 0) {
        console.log(`\n🔍 [Direct Verification] Arama sayfalarında çıkmayan ${candidatesToVerify.length} ilan tek tek kontrol ediliyor (satıldı/kaldırıldı mı?)...`);

        const verifyContext = await browser.newContext({
          viewport: { width: 1366, height: 768 },
          locale: 'en-GB',
          userAgent: REAL_USER_AGENT
        });
        const verifyPage = await verifyContext.newPage();

        try {
          await verifyPage.goto('https://www.autotrader.co.uk', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await solveCloudflareIfPresent(verifyPage);
          await verifyPage.waitForTimeout(2000);

          const chunkSize = 5; // Gentle and safe rate to avoid triggering Cloudflare WAF
          let confirmedSold = 0;
          let confirmedActive = 0;

          for (let i = 0; i < candidatesToVerify.length; i += chunkSize) {
            if (activeAbort) break;
            const chunk = candidatesToVerify.slice(i, i + chunkSize);
            const chunkIds = chunk.map(c => c.id);

            const results = await verifyPage.evaluate(async (ids) => {
              return Promise.all(ids.map(async (id) => {
                try {
                  const url = `https://www.autotrader.co.uk/car-details/${id}`;
                  const controller = new AbortController();
                  const timer = setTimeout(() => controller.abort(), 8000);
                  const res = await fetch(url, { signal: controller.signal });
                  clearTimeout(timer);
                  const isLive = !res.redirected && res.url.includes(id);
                  return { id, isLive, finalUrl: res.url, redirected: res.redirected };
                } catch (e) {
                  return { id, isLive: true, error: e.message }; // safety fallback
                }
              }));
            }, chunkIds).catch(err => {
              console.warn('⚠️ Batch evaluate timeout/error:', err.message);
              return chunkIds.map(id => ({ id, isLive: true }));
            });

            for (const res of results) {
              if (res.isLive) {
                dbOps.markListingActive(res.id);
                confirmedActive++;
              } else {
                dbOps.markListingSold(res.id);
                confirmedSold++;
                console.log(`🏷️ [Car ${res.id}] Confirmed SOLD/DELISTED (Redirected). Marked as Sold.`);
              }
            }

            const processedCount = Math.min(i + chunkSize, candidatesToVerify.length);
            if (processedCount % 15 === 0 || processedCount === candidatesToVerify.length) {
              console.log(`⏳ [Direct Verification] İlerleme: ${processedCount}/${candidatesToVerify.length} (Aktif: ${confirmedActive}, Satılan: ${confirmedSold})`);
            }

            if (i + chunkSize < candidatesToVerify.length) {
              await verifyPage.waitForTimeout(300);
            }
          }

          stats.sold_delisted_count = confirmedSold;
          console.log(`🏁 [Direct Verification Complete] ${confirmedActive} cars verified still active (saved from false delist), ${confirmedSold} cars confirmed sold.`);
        } catch (vErr) {
          console.warn('⚠️ Verification step notice:', vErr.message);
        } finally {
          await verifyContext.close().catch(() => { });
        }
      } else {
        console.log('\n✨ All active database listings were seen on search pages. No delist verification needed.');
      }
    } else if (!completedCleanly) {
      console.log('\n🛡️ [Data Protection] Scrape was interrupted by a page error. Skipping Sold/Delisted verification.');
    }

    dbOps.finishScrapeRun(runId, stats);

    console.log('\n================ Scrape Run Summary ================');
    console.log(`✅ Unique cars processed: ${stats.total_listings_found} (${seenIds.length} total card impressions)`);
    console.log(`✨ New listings added:   ${stats.new_listings_count}`);
    console.log(`📊 Price changes:        ${stats.price_changes_count}`);
    console.log(`🏁 Status:               ${stats.status}`);
    console.log('====================================================\n');

  } catch (err) {
    if (activeAbort) {
      console.log('🛑 Scraper stopped by user request.');
      stats.status = 'failed';
      stats.error_message = 'Stopped by user';
    } else {
      console.error('❌ Scraper error:', err);
      stats.status = 'failed';
      stats.error_message = err.message;
    }
    dbOps.finishScrapeRun(runId, stats);
  } finally {
    if (browser) {
      await browser.close().catch(() => { });
    }
    activeBrowser = null;
  }

  return stats;
}
