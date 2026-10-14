import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve(__dirname, '../../config/proxies.json');

class ProxyManager {
  constructor() {
    this.config = this.loadConfig();
    this.currentIndex = 0;
    this.lastResetTimestamp = 0;
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn('⚠️ Could not load config/proxies.json:', err.message);
    }

    return {
      enabled: false,
      rotationIntervalPages: 5,
      minMobileCooldownSeconds: 60,
      proxies: []
    };
  }

  // Get fresh configuration from disk
  getConfig() {
    this.config = this.loadConfig();
    return this.config;
  }

  // Get currently active proxies list dynamically
  getActiveProxies() {
    this.config = this.loadConfig();
    if (!this.config.enabled || !Array.isArray(this.config.proxies)) {
      return [];
    }
    return this.config.proxies.filter(p => p.active !== false);
  }

  // Returns formatted Playwright proxy options or null if disabled
  getCurrentProxyOptions() {
    const activeList = this.getActiveProxies();
    if (activeList.length === 0) return null;

    const proxy = activeList[this.currentIndex % activeList.length];
    
    // Support IPv4, IPv6, SOCKS5, HTTP
    const protocol = proxy.protocol || 'http';
    const server = `${protocol}://${proxy.host}:${proxy.port}`;

    const opts = { server };
    if (proxy.username) opts.username = proxy.username;
    if (proxy.password) opts.password = proxy.password;

    return {
      playwrightProxy: opts,
      details: proxy
    };
  }

  // Akilli Cooldown Korumali Mobile IP Reset
  async rotateMobileIp(proxy) {
    if (!proxy || proxy.type !== 'mobile_rotating' || !proxy.changeIpUrl) {
      return { success: false, reason: 'Not a mobile rotating proxy' };
    }

    const minCooldownMs = (this.config.minMobileCooldownSeconds || 60) * 1000;
    const now = Date.now();
    const elapsedSinceLastReset = now - this.lastResetTimestamp;

    // Cooldown Guard: If under 60 seconds, wait out the remaining time
    if (elapsedSinceLastReset < minCooldownMs) {
      const waitTimeSec = Math.ceil((minCooldownMs - elapsedSinceLastReset) / 1000);
      console.log(`⏳ [Mobile Proxy Cooldown] Waiting ${waitTimeSec}s before triggering IP reset to avoid modem error...`);
      await new Promise(r => setTimeout(r, waitTimeSec * 1000));
    }

    console.log(`🔄 [Mobile Proxy] Triggering IP rotation URL: ${proxy.changeIpUrl}`);
    try {
      const res = await fetch(proxy.changeIpUrl, { timeout: 15000 });
      const text = await res.text();
      this.lastResetTimestamp = Date.now();
      
      console.log(`📡 [Mobile Proxy] Reset response (${res.status}): ${text.slice(0, 100)}`);
      console.log('📶 Waiting 6s for cellular modem handshake to acquire new IP...');
      await new Promise(r => setTimeout(r, 6000));

      return { success: true, response: text };
    } catch (err) {
      console.error('❌ Failed to trigger mobile IP rotation:', err.message);
      return { success: false, error: err.message };
    }
  }

  // Switch to next proxy on failure/block
  switchNextProxy() {
    const list = this.getActiveProxies();
    if (list.length <= 1) return null;

    this.currentIndex = (this.currentIndex + 1) % list.length;
    const next = list[this.currentIndex];
    console.log(`🔀 Switched to next active proxy: [${next.name || next.host}]`);
    return next;
  }
}

export const proxyManager = new ProxyManager();
