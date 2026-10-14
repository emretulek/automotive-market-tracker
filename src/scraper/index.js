import { runScraper } from './engine.js';
import dotenv from 'dotenv';
dotenv.config();

// Parse command line arguments (e.g. node index.js --pages 50 --workers 4 --headless true)
const args = process.argv.slice(2);
let maxPages = parseInt(process.env.CRON_PAGES || '120', 10);
let headless = process.env.HEADLESS || 'false';
let workers = parseInt(process.env.CONCURRENCY || '4', 10);

let make = process.env.TARGET_MAKE;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pages' && args[i + 1]) {
    maxPages = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i].startsWith('--pages=')) {
    maxPages = parseInt(args[i].split('=')[1], 10);
  } else if (args[i] === '--workers' && args[i + 1]) {
    workers = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i].startsWith('--workers=')) {
    workers = parseInt(args[i].split('=')[1], 10);
  } else if (args[i] === '--make' && args[i + 1]) {
    make = args[i + 1];
    i++;
  } else if (args[i].startsWith('--make=')) {
    make = args[i].split('=')[1];
  } else if (args[i] === '--headless') {
    if (args[i + 1] && !args[i + 1].startsWith('--')) {
      headless = args[i + 1];
      i++;
    } else {
      headless = 'new';
    }
  } else if (args[i].startsWith('--headless=')) {
    headless = args[i].split('=')[1];
  }
}

console.log(`Starting scrape job (make: ${make || 'Default'}, pages: ${maxPages}, workers: ${workers}, headless: ${headless})...`);

runScraper({ make, maxPages, headless, workers })
  .then(stats => {
    console.log('Scraper finished successfully.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Fatal scrape error:', err);
    process.exit(1);
  });
