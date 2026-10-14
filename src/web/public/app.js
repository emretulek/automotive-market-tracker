let modelChartInstance = null;
let priceChartInstance = null;
let modalChartInstance = null;

let currentPage = 1;
const pageSize = 12;
let searchDebounceTimer = null;

// Initialize Dashboard
document.addEventListener('DOMContentLoaded', () => {
  loadOverview();
  loadListings();
  setInterval(checkScraperStatus, 4000);
});

// Load high-level market metrics & charts
async function loadOverview() {
  try {
    const res = await fetch('/api/stats');
    const { success, data, isScraping, cron, proxy, headless, target } = await res.json();
    if (!success) return;

    // Target, Headless, Cron & Proxy badges
    const targetBadge = document.getElementById('targetText');
    if (targetBadge && target) {
      const modelLabel = target.models === 'auto' ? 'Auto-Models' : `${target.models.length} Models`;
      targetBadge.textContent = `${target.make} (${modelLabel})`;
    }

    const headlessBadge = document.getElementById('headlessText');
    if (headlessBadge && headless !== undefined) {
      headlessBadge.textContent = `Headless: ${headless}`;
    }

    if (cron) {
      document.getElementById('cronText').textContent = cron.enabled 
        ? `Cron: ${cron.schedule}` 
        : 'Cron: Standby';
    }
    if (proxy) {
      document.getElementById('proxyText').textContent = proxy.enabled 
        ? `Proxy: ${proxy.current}` 
        : 'Proxy: Direct';
    }

    // 6 Key metrics
    document.getElementById('totalActive').textContent = data.totalActive.toLocaleString();
    document.getElementById('totalSold').textContent = data.totalSold.toLocaleString();
    document.getElementById('avgPrice').textContent = `£${data.avgPrice.toLocaleString()}`;
    document.getElementById('new7d').textContent = data.newLast7d.toLocaleString();
    document.getElementById('new24hMeta').textContent = `${data.newLast24h.toLocaleString()} new in last 24h`;
    
    document.getElementById('priceDrops').textContent = data.priceDropsTotal.toLocaleString();
    document.getElementById('avgDropMeta').textContent = data.avgPriceDrop > 0 
      ? `Avg discount: -£${data.avgPriceDrop.toLocaleString()}` 
      : 'No active reductions';

    document.getElementById('priceIncreases').textContent = data.priceIncreasesTotal.toLocaleString();

    updateScraperBadge(isScraping);
    renderCharts(data.byModel);
  } catch (err) {
    console.error('Failed to load overview stats:', err);
  }
}

// Render Model Distribution & Price Comparison Charts
function renderCharts(byModel) {
  if (!byModel || byModel.length === 0) return;

  const labels = byModel.map(m => m.model);
  const activeCounts = byModel.map(m => m.active_count);
  const avgPrices = byModel.map(m => m.avg_price || 0);

  // 1. Doughnut Chart: Model Share
  const ctxModel = document.getElementById('modelChart').getContext('2d');
  if (modelChartInstance) modelChartInstance.destroy();

  modelChartInstance = new Chart(ctxModel, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: activeCounts,
        backgroundColor: ['#e82127', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b'],
        borderWidth: 0,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#9ca3af', font: { family: 'Plus Jakarta Sans', size: 12 } }
        }
      },
      cutout: '72%'
    }
  });

  // 2. Bar Chart: Average Price by Model
  const ctxPrice = document.getElementById('priceChart').getContext('2d');
  if (priceChartInstance) priceChartInstance.destroy();

  priceChartInstance = new Chart(ctxPrice, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Avg Price (£)',
        data: avgPrices,
        backgroundColor: 'rgba(59, 130, 246, 0.75)',
        hoverBackgroundColor: '#3b82f6',
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#9ca3af' }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            color: '#9ca3af',
            callback: val => `£${(val / 1000).toFixed(0)}k`
          }
        }
      }
    }
  });
}

// Fetch and render paginated listing cards
async function loadListings() {
  const model = document.getElementById('modelFilter').value;
  const status = document.getElementById('statusFilter').value;
  const priceTrend = document.getElementById('trendFilter').value;
  const sortBy = document.getElementById('sortBy').value;
  const search = document.getElementById('searchInput').value;
  const container = document.getElementById('listingsContainer');

  container.innerHTML = '<div style="padding: 40px; text-align: center; color: #9ca3af;">Loading listings...</div>';

  try {
    const params = new URLSearchParams({
      model,
      status,
      priceTrend,
      sortBy,
      search,
      page: currentPage,
      pageSize
    });

    const res = await fetch(`/api/listings?${params.toString()}`);
    const { success, listings, totalCount, totalPages } = await res.json();

    if (!success) {
      container.innerHTML = '<div style="color: #ef4444; padding: 20px;">Failed to load listings.</div>';
      return;
    }

    document.getElementById('listingCount').textContent = `${totalCount} vehicles`;

    // Update Pagination UI
    const startIdx = totalCount === 0 ? 0 : (currentPage - 1) * pageSize + 1;
    const endIdx = Math.min(currentPage * pageSize, totalCount);
    document.getElementById('paginationInfo').textContent = `Showing ${startIdx}-${endIdx} of ${totalCount} listings`;
    document.getElementById('pageIndicator').textContent = `Page ${currentPage} of ${totalPages || 1}`;
    
    document.getElementById('btnPrevPage').disabled = currentPage <= 1;
    document.getElementById('btnNextPage').disabled = currentPage >= totalPages;

    if (!listings || listings.length === 0) {
      container.innerHTML = '<div style="padding: 40px; text-align: center; color: #9ca3af; grid-column: 1 / -1;">No listings found matching criteria.</div>';
      return;
    }

    container.innerHTML = listings.map(car => {
      // Badges
      let trendBadge = '';
      if (car.status === 'sold') {
        trendBadge = '<span class="badge-trend sold">🔴 SOLD</span>';
      } else if (car.price_change < 0) {
        trendBadge = `<span class="badge-trend drop">📉 -£${Math.abs(car.price_change).toLocaleString()}</span>`;
      } else if (car.price_change > 0) {
        trendBadge = `<span class="badge-trend increase">📈 +£${car.price_change.toLocaleString()}</span>`;
      }

      const prevPrice = (car.price_change !== 0) ? (car.price - car.price_change) : car.original_price;
      const origPriceHtml = (car.price_change !== 0 && prevPrice && prevPrice !== car.price) 
        ? `<span class="car-orig-price">£${prevPrice.toLocaleString()}</span>` 
        : '';

      return `
        <div class="car-card ${car.status === 'sold' ? 'sold-card' : ''}">
          <div class="car-image-box">
            <img src="${car.image_url || 'https://images.unsplash.com/photo-1560958089-b8a1929cea89?w=600&auto=format&fit=crop'}" alt="${car.title}" loading="lazy" />
            <span class="badge-model">${car.model}</span>
            ${trendBadge}
          </div>
          <div class="car-body">
            <div class="car-title" title="${car.title}">${car.title}</div>
            <div class="car-specs-row">
              <span class="spec-pill">📅 ${car.year || 'N/A'}</span>
              <span class="spec-pill">🛣️ ${car.mileage ? car.mileage.toLocaleString() + ' mi' : 'N/A'}</span>
              <span class="spec-pill">📍 ${car.location || 'UK'}</span>
            </div>
            <div class="car-footer">
              <div class="price-container">
                <div class="car-price">£${car.price.toLocaleString()}</div>
                ${origPriceHtml}
              </div>
              <div class="car-actions">
                <button class="btn-detail" onclick="openDetailModal('${car.id}')">
                  📊 History & Specs
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    container.innerHTML = '<div style="color: #ef4444; padding: 20px;">Network error loading listings.</div>';
  }
}

// Pagination controls
function changePage(delta) {
  currentPage += delta;
  if (currentPage < 1) currentPage = 1;
  loadListings();
  window.scrollTo({ top: document.querySelector('.inventory-section').offsetTop - 30, behavior: 'smooth' });
}

function resetAndLoadListings() {
  currentPage = 1;
  loadListings();
}

function debounceSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    resetAndLoadListings();
  }, 350);
}

// Vehicle Detail & Price History Modal
async function openDetailModal(id) {
  const modal = document.getElementById('detailModal');
  const modalBody = document.getElementById('modalBody');
  modal.classList.add('open');
  modalBody.innerHTML = '<div style="padding: 40px; text-align: center; color: #9ca3af;">Loading vehicle history...</div>';

  try {
    const res = await fetch(`/api/listings/${id}`);
    const { success, data: car } = await res.json();
    if (!success) {
      modalBody.innerHTML = '<div style="color: #ef4444; padding: 20px;">Failed to load vehicle details.</div>';
      return;
    }

    const latestDiff = car.price_change || 0;
    const overallDiff = (car.price && car.original_price) ? (car.price - car.original_price) : 0;
    
    let diffSign = '';
    if (latestDiff < 0) {
      diffSign = `<span style="color: #10b981; font-weight: 600;">📉 -£${Math.abs(latestDiff).toLocaleString()} latest drop</span>`;
      if (overallDiff !== latestDiff && overallDiff !== 0) {
        const netSign = overallDiff < 0 ? `-£${Math.abs(overallDiff).toLocaleString()}` : `+£${overallDiff.toLocaleString()}`;
        diffSign += ` <span style="color: var(--text-muted); font-size: 12px; margin-left: 6px;">(Overall from start: ${netSign})</span>`;
      }
    } else if (latestDiff > 0) {
      diffSign = `<span style="color: #f59e0b; font-weight: 600;">📈 +£${latestDiff.toLocaleString()} latest increase</span>`;
      if (overallDiff !== latestDiff && overallDiff !== 0) {
        const netSign = overallDiff < 0 ? `-£${Math.abs(overallDiff).toLocaleString()}` : `+£${overallDiff.toLocaleString()}`;
        diffSign += ` <span style="color: var(--text-muted); font-size: 12px; margin-left: 6px;">(Overall from start: ${netSign})</span>`;
      }
    } else {
      diffSign = '<span style="color: #9ca3af;">Price unchanged since first listed</span>';
    }

    // Build History Table rows
    const historyRows = (car.price_history || []).map(h => {
      const diffLabel = h.difference < 0 
        ? `<span style="color: #10b981;">-£${Math.abs(h.difference).toLocaleString()}</span>` 
        : `<span style="color: #f59e0b;">+£${h.difference.toLocaleString()}</span>`;
      return `
        <tr>
          <td>${new Date(h.recorded_at).toLocaleDateString()} ${new Date(h.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
          <td>£${h.old_price.toLocaleString()}</td>
          <td style="font-weight: 700;">£${h.new_price.toLocaleString()}</td>
          <td>${diffLabel}</td>
        </tr>
      `;
    }).join('');

    const historySection = (car.price_history && car.price_history.length > 0) ? `
      <div class="price-history-section">
        <h4 style="font-size: 14px; margin-bottom: 8px;">📈 Price Change Log (${car.price_history.length} adjustments)</h4>
        <div style="height: 180px; margin-bottom: 16px;">
          <canvas id="modalPriceChart"></canvas>
        </div>
        <table class="history-table">
          <thead>
            <tr>
              <th>Date & Time</th>
              <th>Old Price</th>
              <th>New Price</th>
              <th>Adjustment</th>
            </tr>
          </thead>
          <tbody>
            ${historyRows}
          </tbody>
        </table>
      </div>
    ` : `
      <div class="price-history-section" style="text-align: center; color: var(--text-muted); padding: 24px;">
        ℹ️ No price modifications recorded yet. Original listing price: £${car.price.toLocaleString()}.
      </div>
    `;

    modalBody.innerHTML = `
      <div class="modal-header-hero">
        <img class="modal-hero-img" src="${car.image_url || 'https://images.unsplash.com/photo-1560958089-b8a1929cea89?w=600'}" alt="${car.title}" />
        <div class="modal-hero-info">
          <div style="display: flex; gap: 8px; margin-bottom: 6px;">
            <span class="badge-model" style="position: static;">${car.model}</span>
            <span class="count-tag" style="background: rgba(255,255,255,0.06); color: #fff;">${car.status.toUpperCase()}</span>
          </div>
          <h2 style="font-size: 18px; line-height: 1.3;">${car.title}</h2>
          <div class="modal-price-tag">£${car.price.toLocaleString()}</div>
          <div style="font-size: 13px; margin-top: 4px;">${diffSign}</div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 20px;">
        <div class="spec-pill" style="padding: 10px; flex-direction: column; align-items: flex-start;">
          <span style="color: var(--text-muted); font-size: 11px;">MILEAGE</span>
          <span style="font-weight: 700;">${car.mileage ? car.mileage.toLocaleString() + ' mi' : 'N/A'}</span>
        </div>
        <div class="spec-pill" style="padding: 10px; flex-direction: column; align-items: flex-start;">
          <span style="color: var(--text-muted); font-size: 11px;">REG YEAR</span>
          <span style="font-weight: 700;">${car.year || 'N/A'}</span>
        </div>
        <div class="spec-pill" style="padding: 10px; flex-direction: column; align-items: flex-start;">
          <span style="color: var(--text-muted); font-size: 11px;">SELLER</span>
          <span style="font-weight: 700;">${car.seller_type}</span>
        </div>
        <div class="spec-pill" style="padding: 10px; flex-direction: column; align-items: flex-start;">
          <span style="color: var(--text-muted); font-size: 11px;">LOCATION</span>
          <span style="font-weight: 700;">${car.location || 'UK'}</span>
        </div>
      </div>

      ${historySection}

      <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px;">
        <button class="btn-page" onclick="closeModal()">Close</button>
        <a href="${car.url}" target="_blank" rel="noopener noreferrer" class="btn-primary" style="text-decoration: none;">
          Open on AutoTrader UK ↗
        </a>
      </div>
    `;

    // Render Price Timeline Chart if history exists
    if (car.price_history && car.price_history.length > 0) {
      const historyPoints = [
        { date: new Date(car.first_seen_at).toLocaleDateString(), price: car.original_price },
        ...car.price_history.map(h => ({ date: new Date(h.recorded_at).toLocaleDateString(), price: h.new_price }))
      ];

      const ctxModal = document.getElementById('modalPriceChart').getContext('2d');
      if (modalChartInstance) modalChartInstance.destroy();

      modalChartInstance = new Chart(ctxModal, {
        type: 'line',
        data: {
          labels: historyPoints.map(p => p.date),
          datasets: [{
            label: 'Listing Price (£)',
            data: historyPoints.map(p => p.price),
            borderColor: '#06b6d4',
            backgroundColor: 'rgba(6, 182, 212, 0.15)',
            borderWidth: 2,
            pointBackgroundColor: '#06b6d4',
            fill: true,
            tension: 0.2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#9ca3af' } },
            y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#9ca3af', callback: v => `£${v.toLocaleString()}` } }
          }
        }
      });
    }

  } catch (err) {
    modalBody.innerHTML = '<div style="color: #ef4444; padding: 20px;">Network error loading vehicle details.</div>';
  }
}

function closeModal() {
  document.getElementById('detailModal').classList.remove('open');
}

function closeModalOnBackdrop(e) {
  if (e.target.id === 'detailModal') {
    closeModal();
  }
}

// Trigger scraper from button
async function triggerScraper() {
  const btn = document.getElementById('scrapeBtn');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}) // Uses .env HEADLESS mode automatically!
    });
    const result = await res.json();
    alert(result.message || 'Scraper job dispatched.');
    updateScraperBadge(true);
  } catch (err) {
    alert('Failed to trigger scraper.');
    btn.disabled = false;
    btn.textContent = 'Run Scraper';
  }
}

// Check scraper status periodically
async function checkScraperStatus() {
  try {
    const res = await fetch('/api/stats');
    const { data, isScraping } = await res.json();
    updateScraperBadge(isScraping);
    if (!isScraping) {
      const btn = document.getElementById('scrapeBtn');
      if (btn.disabled) {
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"></polyline>
            <polyline points="1 20 1 14 7 14"></polyline>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
          </svg>
          Run Scraper
        `;
        loadOverview();
        loadListings();
      }
    }
  } catch (e) {}
}

function updateScraperBadge(isScraping) {
  const badge = document.getElementById('scraperStatus');
  const text = document.getElementById('statusText');
  const scrapeBtn = document.getElementById('scrapeBtn');
  const stopBtn = document.getElementById('stopBtn');

  if (isScraping) {
    if (badge) badge.classList.add('running');
    if (text) text.textContent = 'Scraper Running...';
    if (scrapeBtn) scrapeBtn.style.display = 'none';
    if (stopBtn) {
      stopBtn.style.display = 'flex';
      stopBtn.disabled = false;
      stopBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        </svg>
        Stop Scraper
      `;
    }
  } else {
    if (badge) badge.classList.remove('running');
    if (text) text.textContent = 'System Ready';
    if (stopBtn) stopBtn.style.display = 'none';
    if (scrapeBtn) {
      scrapeBtn.style.display = 'flex';
      scrapeBtn.disabled = false;
      scrapeBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
        Run Scraper
      `;
    }
  }
}

// Stop active scraper job
async function stopScraperAction() {
  const stopBtn = document.getElementById('stopBtn');
  if (stopBtn) {
    stopBtn.disabled = true;
    stopBtn.innerHTML = 'Stopping...';
  }

  try {
    const res = await fetch('/api/scrape/stop', { method: 'POST' });
    const result = await res.json();
    alert(result.message || 'Scraper stop command sent.');
    updateScraperBadge(false);
    loadOverview();
    if (document.getElementById('runsModal')?.classList.contains('open')) {
      fetchAndRenderRuns();
    }
  } catch (err) {
    alert('Failed to stop scraper: ' + err.message);
  } finally {
    if (stopBtn) {
      stopBtn.disabled = false;
    }
  }
}

// Scrape Runs History Modal Handlers
async function openRunsModal() {
  const modal = document.getElementById('runsModal');
  if (!modal) return;
  modal.classList.add('open');
  await fetchAndRenderRuns();
}

function closeRunsModal() {
  const modal = document.getElementById('runsModal');
  if (modal) modal.classList.remove('open');
}

function closeRunsModalOnBackdrop(e) {
  if (e.target.id === 'runsModal') {
    closeRunsModal();
  }
}

async function fetchAndRenderRuns() {
  const container = document.getElementById('runsModalBody');
  if (!container) return;
  container.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted);">Fetching recent scrape runs...</div>';

  try {
    const res = await fetch('/api/runs?limit=25');
    const { success, data: runs } = await res.json();

    if (!success || !runs || runs.length === 0) {
      container.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted);">No recorded scrape runs found yet.</div>';
      return;
    }

    let html = `
      <table class="runs-table">
        <thead>
          <tr>
            <th>Run ID</th>
            <th>Status</th>
            <th>Started</th>
            <th>Duration</th>
            <th>Found</th>
            <th>New</th>
            <th>Drops</th>
            <th>Error / Diagnostics</th>
          </tr>
        </thead>
        <tbody>
    `;

    runs.forEach(run => {
      let durationStr = '-';
      if (run.started_at && run.completed_at) {
        const start = new Date(run.started_at.replace(' ', 'T') + 'Z');
        const end = new Date(run.completed_at.replace(' ', 'T') + 'Z');
        const diffMs = end - start;
        if (!isNaN(diffMs) && diffMs >= 0) {
          const sec = Math.floor(diffMs / 1000);
          const min = Math.floor(sec / 60);
          durationStr = min > 0 ? `${min}m ${sec % 60}s` : `${sec}s`;
        }
      } else if (run.status === 'running') {
        durationStr = '⏳ In progress...';
      }

      const statusBadge = `<span class="run-badge ${run.status}">${run.status}</span>`;
      const errorContent = run.error_message 
        ? `<span style="color: #ef4444; font-family: monospace; font-size: 11px;" title="${escapeHtml(run.error_message)}">${escapeHtml(run.error_message.slice(0, 50))}${run.error_message.length > 50 ? '...' : ''}</span>`
        : '<span style="color: var(--text-muted);">-</span>';

      html += `
        <tr>
          <td style="font-weight: 700; color: #fff;">#${run.id}</td>
          <td>${statusBadge}</td>
          <td style="color: var(--text-muted); font-size: 12px;">${run.started_at || '-'}</td>
          <td style="color: #cbd5e1; font-weight: 500;">${durationStr}</td>
          <td style="font-weight: 700; color: #fff;">${run.total_listings_found || 0}</td>
          <td style="color: #10b981; font-weight: 600;">+${run.new_listings_count || 0}</td>
          <td style="color: #f59e0b; font-weight: 600;">${run.price_changes_count || 0}</td>
          <td>${errorContent}</td>
        </tr>
      `;
    });

    html += `
        </tbody>
      </table>
    `;

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div style="padding: 24px; text-align: center; color: #ef4444;">Failed to load runs: ${err.message}</div>`;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function clearRunsHistory() {
  if (!confirm('Are you sure you want to clear all scrape logs and error history?')) return;
  try {
    const res = await fetch('/api/runs', { method: 'DELETE' });
    const result = await res.json();
    await fetchAndRenderRuns();
  } catch (err) {
    alert('Failed to clear logs: ' + err.message);
  }
}

// Expose to window for inline onclick handlers
window.openDetailModal = openDetailModal;
window.closeModal = closeModal;
window.closeModalOnBackdrop = closeModalOnBackdrop;
window.changePage = changePage;
window.resetAndLoadListings = resetAndLoadListings;
window.debounceSearch = debounceSearch;
window.triggerScraper = triggerScraper;
window.openRunsModal = openRunsModal;
window.closeRunsModal = closeRunsModal;
window.closeRunsModalOnBackdrop = closeRunsModalOnBackdrop;
window.fetchAndRenderRuns = fetchAndRenderRuns;
window.clearRunsHistory = clearRunsHistory;
window.stopScraperAction = stopScraperAction;

