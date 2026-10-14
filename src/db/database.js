import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'tracker.sqlite');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Initialize schema
const schemaPath = path.join(__dirname, 'schema.sql');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');
db.exec(schemaSql);

/**
 * Database operations for listings and price history
 */
export const dbOps = {
  // Get an existing listing by ID
  getListingById(id) {
    return db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
  },

  // Insert a newly discovered listing (idempotent, never duplicates)
  insertListing(car) {
    const stmt = db.prepare(`
      INSERT INTO listings (
        id, title, model, variant, year, mileage, price, original_price,
        price_change, location, seller_type, url, image_url, status,
        first_seen_at, last_seen_at, status_updated_at, specs_json
      ) VALUES (
        @id, @title, @model, @variant, @year, @mileage, @price, @original_price,
        0, @location, @seller_type, @url, @image_url, 'active',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, @specs_json
      )
      ON CONFLICT(id) DO UPDATE SET
        last_seen_at = CURRENT_TIMESTAMP,
        status = 'active'
    `);
    return stmt.run(car);
  },

  // Update existing listing (mark seen, update price if changed)
  updateListing(id, updates) {
    const { price, oldPrice } = updates;

    if (price && oldPrice && price !== oldPrice) {
      const diff = price - oldPrice;
      db.prepare(`
        INSERT INTO price_history (listing_id, old_price, new_price, difference, recorded_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(id, oldPrice, price, diff);

      return db.prepare(`
        UPDATE listings
        SET price = ?,
            price_change = ?,
            last_seen_at = CURRENT_TIMESTAMP,
            status = 'active',
            status_updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(price, diff, id);
    } else {
      return db.prepare(`
        UPDATE listings
        SET last_seen_at = CURRENT_TIMESTAMP,
            status = 'active'
        WHERE id = ?
      `).run(id);
    }
  },

  // Get count of currently active listings
  getActiveCount() {
    const row = db.prepare("SELECT COUNT(*) as count FROM listings WHERE status = 'active'").get();
    return row ? row.count : 0;
  },

  // Get active listings (optionally by make) for verification
  getActiveListings(make) {
    if (make) {
      return db.prepare("SELECT id, url, title, model, price FROM listings WHERE status = 'active' AND title LIKE ?").all(`%${make}%`);
    }
    return db.prepare("SELECT id, url, title, model, price FROM listings WHERE status = 'active'").all();
  },

  // Mark single listing as sold after direct verification
  markListingSold(id) {
    return db.prepare("UPDATE listings SET status = 'sold', status_updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  },

  // Mark single listing as confirmed active after direct verification
  markListingActive(id) {
    return db.prepare("UPDATE listings SET status = 'active', last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  },

  // Mark listings as sold/delisted ONLY IF they have not been seen in the current run
  // AND have not been seen for at least 24 hours (protects against pagination shifts)
  markDelistedExcept(seenIds, startedAt) {
    if (!seenIds || seenIds.length === 0) return { changes: 0 };

    const placeholders = seenIds.map(() => '?').join(',');
    const stmt = db.prepare(`
      UPDATE listings
      SET status = 'sold',
          status_updated_at = CURRENT_TIMESTAMP
      WHERE status = 'active'
        AND id NOT IN (${placeholders})
        AND last_seen_at < datetime('now', '-24 hours')
    `);
    return stmt.run(...seenIds);
  },

  // Scrape run management
  createScrapeRun() {
    const stmt = db.prepare(`
      INSERT INTO scrape_runs (started_at, status)
      VALUES (CURRENT_TIMESTAMP, 'running')
    `);
    const info = stmt.run();
    return info.lastInsertRowid;
  },

  finishScrapeRun(runId, stats) {
    const stmt = db.prepare(`
      UPDATE scrape_runs
      SET completed_at = CURRENT_TIMESTAMP,
          total_listings_found = @total_listings_found,
          new_listings_count = @new_listings_count,
          price_changes_count = @price_changes_count,
          sold_delisted_count = @sold_delisted_count,
          status = @status,
          error_message = @error_message
      WHERE id = @runId
    `);
    return stmt.run({ ...stats, runId });
  },

  // Rich market metrics & statistics
  getMarketOverview() {
    const totalActive = db.prepare(`SELECT COUNT(*) as count, AVG(price) as avg_price FROM listings WHERE status = 'active'`).get();
    const totalSold = db.prepare(`SELECT COUNT(*) as count FROM listings WHERE status = 'sold'`).get();
    
    const newLast24h = db.prepare(`SELECT COUNT(*) as count FROM listings WHERE first_seen_at >= datetime('now', '-1 day')`).get();
    const newLast7d = db.prepare(`SELECT COUNT(*) as count FROM listings WHERE first_seen_at >= datetime('now', '-7 days')`).get();
    const newLast30d = db.prepare(`SELECT COUNT(*) as count FROM listings WHERE first_seen_at >= datetime('now', '-30 days')`).get();

    const soldLast7d = db.prepare(`SELECT COUNT(*) as count FROM listings WHERE status = 'sold' AND status_updated_at >= datetime('now', '-7 days')`).get();
    const soldLast30d = db.prepare(`SELECT COUNT(*) as count FROM listings WHERE status = 'sold' AND status_updated_at >= datetime('now', '-30 days')`).get();

    const priceDrops = db.prepare(`
      SELECT COUNT(*) as count, AVG(ABS(price_change)) as avg_drop 
      FROM listings 
      WHERE price_change < 0
    `).get();

    const priceIncreases = db.prepare(`
      SELECT COUNT(*) as count 
      FROM listings 
      WHERE price_change > 0
    `).get();
    
    const byModel = db.prepare(`
      SELECT 
        model, 
        COUNT(*) as total_count,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
        SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END) as sold_count,
        ROUND(AVG(CASE WHEN status = 'active' THEN price ELSE NULL END)) as avg_price,
        MIN(CASE WHEN status = 'active' THEN price ELSE NULL END) as min_price,
        MAX(CASE WHEN status = 'active' THEN price ELSE NULL END) as max_price
      FROM listings
      WHERE model IS NOT NULL
      GROUP BY model
      ORDER BY active_count DESC
    `).all();

    return {
      totalActive: totalActive.count || 0,
      totalSold: totalSold.count || 0,
      avgPrice: Math.round(totalActive.avg_price || 0),
      newLast24h: newLast24h.count || 0,
      newLast7d: newLast7d.count || 0,
      newLast30d: newLast30d.count || 0,
      soldLast7d: soldLast7d.count || 0,
      soldLast30d: soldLast30d.count || 0,
      priceDropsTotal: priceDrops.count || 0,
      avgPriceDrop: Math.round(priceDrops.avg_drop || 0),
      priceIncreasesTotal: priceIncreases.count || 0,
      byModel
    };
  },

  // Query listings with pagination, status filters, and price trend filters
  getListings(options = {}) {
    const {
      model,
      status = 'all',
      priceTrend = 'all', // 'all', 'dropped', 'increased'
      search,
      sortBy = 'date_desc',
      page = 1,
      pageSize = 12
    } = options;

    let whereClause = ' WHERE 1=1';
    const params = [];

    // Filter by status (active / sold / all)
    if (status && status !== 'all') {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    // Filter by model
    if (model && model !== 'all') {
      whereClause += ' AND model = ?';
      params.push(model);
    }

    // Filter by price trend (dropped / increased)
    if (priceTrend === 'dropped') {
      whereClause += ' AND price_change < 0';
    } else if (priceTrend === 'increased') {
      whereClause += ' AND price_change > 0';
    }

    // Search query
    if (search && search.trim()) {
      whereClause += ' AND (title LIKE ? OR location LIKE ? OR variant LIKE ?)';
      const term = `%${search.trim()}%`;
      params.push(term, term, term);
    }

    // Get total count matching filters
    const countRow = db.prepare(`SELECT COUNT(*) as total FROM listings ${whereClause}`).get(...params);
    const totalCount = countRow ? countRow.total : 0;
    const totalPages = Math.ceil(totalCount / pageSize) || 1;
    const currentPage = Math.max(1, Math.min(Number(page), totalPages));
    const offset = (currentPage - 1) * pageSize;

    // Sorting
    let orderSql = ' ORDER BY last_seen_at DESC';
    switch (sortBy) {
      case 'price_asc':
        orderSql = ' ORDER BY price ASC';
        break;
      case 'price_desc':
        orderSql = ' ORDER BY price DESC';
        break;
      case 'price_drop':
        orderSql = ' ORDER BY price_change ASC'; // biggest negative drop first
        break;
      case 'price_increase':
        orderSql = ' ORDER BY price_change DESC';
        break;
      case 'mileage_asc':
        orderSql = ' ORDER BY mileage ASC';
        break;
      case 'year_desc':
        orderSql = ' ORDER BY year DESC';
        break;
      case 'date_desc':
      default:
        orderSql = ' ORDER BY last_seen_at DESC';
        break;
    }

    const rows = db.prepare(`
      SELECT * FROM listings
      ${whereClause}
      ${orderSql}
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    return {
      listings: rows,
      totalCount,
      totalPages,
      currentPage,
      pageSize
    };
  },

  // Detailed vehicle info with full price change history
  getListingDetail(id) {
    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
    if (!listing) return null;

    const history = db.prepare(`
      SELECT * FROM price_history
      WHERE listing_id = ?
      ORDER BY recorded_at ASC
    `).all(id);

    let specs = [];
    try {
      specs = JSON.parse(listing.specs_json || '[]');
    } catch (e) {}

    return {
      ...listing,
      specs,
      price_history: history
    };
  },

  // Get recent price drops / changes
  getRecentPriceChanges(limit = 10) {
    return db.prepare(`
      SELECT ph.*, l.title, l.model, l.image_url, l.url, l.year, l.mileage
      FROM price_history ph
      JOIN listings l ON ph.listing_id = l.id
      ORDER BY ph.recorded_at DESC
      LIMIT ?
    `).all(limit);
  },

  // Get last scrape runs
  getRecentRuns(limit = 5) {
    return db.prepare(`
      SELECT * FROM scrape_runs
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
  },

  // Clean orphaned 'running' runs from previous crashes / abrupt kills
  cleanOrphanedRuns() {
    return db.prepare(`
      UPDATE scrape_runs
      SET status = 'failed',
          completed_at = CURRENT_TIMESTAMP,
          error_message = 'Interrupted / stopped by user'
      WHERE status = 'running'
    `).run();
  },

  // Clear all past scrape run logs
  clearRuns() {
    return db.prepare('DELETE FROM scrape_runs').run();
  }
};

// Clean any orphaned runs on startup
dbOps.cleanOrphanedRuns();
