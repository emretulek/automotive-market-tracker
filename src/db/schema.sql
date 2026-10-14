-- Automotive Market Tracker Database Schema

CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT,
    variant TEXT,
    year INTEGER,
    mileage INTEGER,
    price INTEGER NOT NULL,
    original_price INTEGER NOT NULL,
    price_change INTEGER DEFAULT 0,
    location TEXT,
    seller_type TEXT,
    url TEXT NOT NULL,
    image_url TEXT,
    status TEXT DEFAULT 'active', -- 'active', 'sold', 'delisted'
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    specs_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_model ON listings(model);
CREATE INDEX IF NOT EXISTS idx_listings_year ON listings(year);
CREATE INDEX IF NOT EXISTS idx_listings_first_seen ON listings(first_seen_at);
CREATE INDEX IF NOT EXISTS idx_listings_last_seen ON listings(last_seen_at);

CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT NOT NULL,
    old_price INTEGER NOT NULL,
    new_price INTEGER NOT NULL,
    difference INTEGER NOT NULL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_price_history_listing ON price_history(listing_id);
CREATE INDEX IF NOT EXISTS idx_price_history_recorded ON price_history(recorded_at);

CREATE TABLE IF NOT EXISTS scrape_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    total_listings_found INTEGER DEFAULT 0,
    new_listings_count INTEGER DEFAULT 0,
    price_changes_count INTEGER DEFAULT 0,
    sold_delisted_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running', -- 'running', 'completed', 'failed'
    error_message TEXT
);
