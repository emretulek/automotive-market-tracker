import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solveCloudflareIfPresent } from './humanMouse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve(__dirname, '../../config/targets.json');

// Curated fallbacks in case homepage dropdown is blocked or unavailable
const KNOWN_MAKE_MODELS = {
  Tesla: ['Model 3', 'Model Y', 'Model S', 'Model X', 'Cybertruck', 'Roadster'],
  BMW: ['1 Series', '2 Series', '3 Series', '4 Series', '5 Series', 'i4', 'iX', 'M3', 'M4'],
  Audi: ['A1', 'A3', 'A4', 'A5', 'A6', 'Q3', 'Q5', 'e-tron'],
  Porsche: ['911', 'Taycan', 'Macan', 'Cayenne', 'Panamera', '718']
};

export const targetManager = {
  getConfig() {
    let config = {
      make: process.env.TARGET_MAKE || 'Tesla',
      models: 'auto',
      postcode: 'SW1A 1AA',
      maxPagesPerModel: 100
    };

    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const fileData = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        config = { ...config, ...fileData };
      } catch (e) {
        console.warn('⚠️ Could not parse config/targets.json, using defaults.');
      }
    }

    if (process.env.TARGET_MAKE) {
      config.make = process.env.TARGET_MAKE;
    }

    return config;
  },

  /**
   * Discovers models dynamically from AutoTrader's taxonomy
   * @param {import('patchright').Page} page
   * @param {string} make
   * @returns {Promise<Array<{name: string, value: string, count: number, pages: number}>>}
   */
  async discoverModels(page, make = 'Tesla') {
    const config = this.getConfig();

    // If explicit models are configured (not 'auto'), return them directly
    if (Array.isArray(config.models) && config.models.length > 0) {
      console.log(`📋 [Target Config] Using ${config.models.length} explicitly specified models for ${make}: ${config.models.join(', ')}`);
      return config.models.map(m => ({
        name: m,
        value: m,
        count: null,
        pages: config.maxPagesPerModel || 100
      }));
    }

    console.log(`🔍 [Auto-Discovery] Inspecting AutoTrader taxonomy for make: "${make}"...`);
    try {
      await page.goto('https://www.autotrader.co.uk/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await solveCloudflareIfPresent(page);
      await page.waitForTimeout(2000);

      // Dismiss cookie consent if visible
      try {
        const frame = page.frameLocator('iframe[id*="sp_message_iframe"]');
        const accept = frame.getByRole('button', { name: /(Accept|Agree)/i });
        if (await accept.isVisible({ timeout: 2500 })) {
          await accept.click();
        }
      } catch (e) {}

      // Find make select
      const makeSelect = page.locator('select#make, select[name="make"]');
      if (await makeSelect.isVisible({ timeout: 5000 })) {
        const makes = await page.evaluate(() => {
          const sel = document.querySelector('select#make, select[name="make"]');
          if (!sel) return [];
          return Array.from(sel.options).map(o => ({ value: o.value, text: o.text }));
        });

        const targetOption = makes.find(m => m.text.toLowerCase().includes(make.toLowerCase()) || m.value.toLowerCase() === make.toLowerCase());
        if (targetOption && targetOption.value) {
          await page.selectOption('select#make, select[name="make"]', targetOption.value);
          await page.waitForTimeout(2000);

          const models = await page.evaluate(() => {
            const sel = document.querySelector('select#model, select[name="model"]');
            if (!sel) return [];
            return Array.from(sel.options)
              .map(o => {
                const countMatch = o.text.match(/\(([\d,]+)\)/);
                const count = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : 0;
                return {
                  name: o.value,
                  value: o.value,
                  rawText: o.text,
                  count
                };
              })
              .filter(o => o.value && o.count > 0);
          });

          if (models.length > 0) {
            console.log(`✨ [Auto-Discovery Success] Discovered ${models.length} active models for ${make}:`);
            let totalDiscoveredPages = 0;
            models.forEach(m => {
              const pages = Math.min(Math.ceil(m.count / 24), config.maxPagesPerModel || 100);
              m.pages = pages;
              totalDiscoveredPages += pages;
              console.log(`   • ${m.name}: ${m.count.toLocaleString()} vehicles -> ${pages} pages`);
            });
            console.log(`🎯 Total exact market workload: ${totalDiscoveredPages} pages.`);
            return models;
          }
        }
      }
    } catch (err) {
      console.warn(`⚠️ Dynamic taxonomy discovery notice: ${err.message}. Using calibrated fallback.`);
    }

    // Calibrated fallback list with realistic page estimates if discovery is blocked
    const fallbackList = KNOWN_MAKE_MODELS[make] || ['Model 3', 'Model Y', 'Model S', 'Model X'];
    console.log(`🛡️ [Calibrated Fallback Active] Queuing ${fallbackList.length} models for ${make}: ${fallbackList.join(', ')}`);
    return fallbackList.map(m => {
      let estPages = 30;
      if (m.includes('3')) estPages = 45;
      else if (m.includes('Y')) estPages = 58;
      else if (m.includes('S')) estPages = 7;
      else if (m.includes('X')) estPages = 6;
      else if (m.includes('Roadster') || m.includes('Cyber')) estPages = 1;
      return {
        name: m,
        value: m,
        count: null,
        pages: Math.min(estPages, config.maxPagesPerModel || 100)
      };
    });
  }
};
