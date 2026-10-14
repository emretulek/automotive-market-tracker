import cron from 'node-cron';
import { runScraper } from '../scraper/engine.js';
import dotenv from 'dotenv';

dotenv.config();

let cronTask = null;
let lastRunAt = null;
let isJobRunning = false;

export function initCronScheduler() {
  const isEnabled = process.env.CRON_ENABLED === 'true';
  const schedule = process.env.CRON_SCHEDULE || '0 3 * * *'; // Default: 03:00 AM daily
  const pagesToScrape = parseInt(process.env.CRON_PAGES || '50', 10);

  if (!isEnabled) {
    console.log('⏰ Automated Cron Scheduler is disabled in .env (CRON_ENABLED=false).');
    return null;
  }

  if (!cron.validate(schedule)) {
    console.error(`❌ Invalid CRON_SCHEDULE expression: "${schedule}". Scheduler aborted.`);
    return null;
  }

  console.log(`⏰ Cron Scheduler activated! Expression: "${schedule}" (Scraping up to ${pagesToScrape} pages).`);

  cronTask = cron.schedule(schedule, async () => {
    if (isJobRunning) {
      console.log('⚠️ Scheduled scrape skipped: previous scrape job is still active.');
      return;
    }

    console.log(`\n🔔 [CRON TRIGGER] Starting scheduled AutoTrader market scan at ${new Date().toISOString()}...`);
    isJobRunning = true;
    lastRunAt = new Date().toISOString();

    try {
      await runScraper({
        maxPages: pagesToScrape,
        headless: process.env.HEADLESS || 'new'
      });
      console.log('🏁 [CRON FINISHED] Scheduled market scan completed successfully.');
    } catch (err) {
      console.error('❌ [CRON ERROR] Scheduled scrape encountered an error:', err.message);
    } finally {
      isJobRunning = false;
    }
  });

  return cronTask;
}

export function getCronStatus() {
  const isEnabled = process.env.CRON_ENABLED === 'true';
  const schedule = process.env.CRON_SCHEDULE || '0 3 * * *';

  return {
    enabled: isEnabled,
    schedule,
    isJobRunning,
    lastRunAt
  };
}
