/**
 * Parser for AutoTrader UK Tesla listing cards
 */
export function parseCardFromText(id, fullText, link, img, defaultModel = null, make = 'Tesla') {
  if (!id || !fullText) return null;

  const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);

  // 1. Model detection
  let model = defaultModel || 'Other';
  if (!defaultModel) {
    if (/Model\s*3/i.test(fullText)) model = 'Model 3';
    else if (/Model\s*Y/i.test(fullText)) model = 'Model Y';
    else if (/Model\s*S/i.test(fullText)) model = 'Model S';
    else if (/Model\s*X/i.test(fullText)) model = 'Model X';
    else if (/Cybertruck/i.test(fullText)) model = 'Cybertruck';
    else if (/Roadster/i.test(fullText)) model = 'Roadster';
  }

  // 2. Variant / Trim detection
  let variant = '';
  if (/Performance/i.test(fullText)) variant = 'Performance';
  else if (/Long\s*Range/i.test(fullText)) variant = 'Long Range';
  else if (/Standard\s*Range/i.test(fullText)) variant = 'Standard Range';
  else if (/Plaid/i.test(fullText)) variant = 'Plaid';
  else if (/75D/i.test(fullText)) variant = '75D';
  else if (/85D/i.test(fullText)) variant = '85D';
  else if (/90D/i.test(fullText)) variant = '90D';
  else if (/100D/i.test(fullText)) variant = '100D';
  else if (/RWD/i.test(fullText)) variant = 'RWD';
  else if (/AWD|4WDE|4WD/i.test(fullText)) variant = 'AWD';

  // 3. Price: look for standalone "£XX,XXX" or line with "£"
  let price = 0;
  const priceMatches = fullText.match(/£([0-9]{1,3}(?:,[0-9]{3})+)(?!\s*\/mo|\s*per month)/g) || fullText.match(/£([0-9]{4,6})(?!\s*\/mo)/g);
  if (priceMatches && priceMatches.length > 0) {
    const nums = priceMatches.map(p => parseInt(p.replace(/[^0-9]/g, ''), 10));
    const carPrices = nums.filter(n => n > 3000);
    if (carPrices.length > 0) price = carPrices[0];
  }

  if (!price) return null;

  // 4. Mileage (e.g. "50,788 miles")
  let mileage = 0;
  const mileMatch = fullText.match(/([\d,]+)\s*miles\b/i);
  if (mileMatch && !mileMatch[0].includes('radius') && !mileMatch[0].includes('away')) {
    mileage = parseInt(mileMatch[1].replace(/,/g, ''), 10);
  }

  // 5. Year (e.g. "2022 (72 reg)" or "2019 (19 reg)")
  let year = null;
  const yearMatch = fullText.match(/\b(201\d|202\d)\s*(?:\(\d+\s*reg\))?/i);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
  }

  // 6. Title
  let title = `${make} ${model}`;
  const descLine = lines.find(l => l.includes('Auto') || l.includes('Dual Motor') || l.includes('4WDE'));
  if (descLine) {
    title = `${make} ${model} ${descLine.replace(/,.*$/, '').trim()}`;
  } else if (variant) {
    title += ` ${variant}`;
  }

  // 7. Location
  let location = 'UK';
  const locMatch = fullText.match(/(?:Dealer location|Available from)\s*([A-Za-z\s]+?)(?:\(|\d|\b)/i) || fullText.match(/location\s*([A-Za-z\s]+)/i);
  if (locMatch) {
    location = locMatch[1].trim();
  }

  // 8. Seller Type
  const sellerType = fullText.toLowerCase().includes('private seller') ? 'Private' : 'Trade';

  return {
    id,
    title,
    model,
    variant,
    year: year || 2021,
    mileage,
    price,
    original_price: price,
    location,
    seller_type: sellerType,
    url: link ? `https://www.autotrader.co.uk/car-details/${id}` : '',
    image_url: img || null,
    specs_json: JSON.stringify(lines.filter(l => l.length < 50))
  };
}
