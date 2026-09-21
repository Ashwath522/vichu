const fs = require('fs');
const path = require('path');

const categories = ['dining', 'living_room', 'storage', 'lighting_decor', 'bedroom'];
const MIN_WORDS = 70, MAX_WORDS = 110;
const {
  checkOpeningFuzzySimilarity,
  extractOpeningLine,
} = require('./generate_pipeline');

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

for (const cat of categories) {
  const p = path.join(__dirname, 'output', `${cat}.jsonl`);
  if (!fs.existsSync(p)) {
    console.log(`\n=== ${cat}: no output file yet ===`);
    continue;
  }
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  let outOfRange = 0;
  let repeatedOpeners = 0;
  const wcs = [];
  const wordFreq = {};
  const openings = [];

  lines.forEach((line) => {
    const obj = JSON.parse(line);
    const content = obj.messages[2].content;
    const wc = countWords(content);
    wcs.push(wc);
    if (wc < MIN_WORDS || wc > MAX_WORDS) outOfRange++;
    const opening = extractOpeningLine(content);
    if (checkOpeningFuzzySimilarity(opening, openings)) repeatedOpeners++;
    openings.push(opening);
    content.toLowerCase().match(/[a-z]+/g)?.forEach((w) => {
      if (w.length > 3) wordFreq[w] = (wordFreq[w] || 0) + 1;
    });
  });

  const avg = wcs.length ? (wcs.reduce((a, b) => a + b, 0) / wcs.length).toFixed(1) : 0;
  const top10 = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);

  console.log(`\n=== ${cat}: ${lines.length} items ===`);
  console.log(`Word count: avg ${avg}, out of 70-110 range: ${outOfRange}/${lines.length}`);
  console.log(`Similar openings found: ${repeatedOpeners}/${lines.length}`);
  console.log(`Top 10 words:`, top10.map(([w, c]) => `${w}(${c})`).join(', '));
  console.log(`Sample (first item):`);
  console.log(JSON.parse(lines[0]).messages[2].content);
  console.log(`Sample (last item):`);
  console.log(JSON.parse(lines[lines.length - 1]).messages[2].content);
}

console.log('\n=== Direction usage ===');
const trackerPath = path.join(__dirname, 'state', 'repetition_tracker.json');
if (fs.existsSync(trackerPath)) {
  const tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
  const directionCounts = Object.entries(tracker.direction_counts || {}).sort((a, b) => b[1] - a[1]);
  console.log(directionCounts.length ? directionCounts.map(([d, c]) => `${d}(${c})`).join(', ') : 'none recorded yet');
  const restricted = tracker.restricted_words || [];
  console.log(`Restricted words currently tracked: ${restricted.length}`);
  if (restricted.length) console.log(`Latest restricted words: ${restricted.slice(-20).join(', ')}`);
} else {
  console.log('no tracker file yet');
}

console.log('\n=== Quality warnings kept despite retry ===');
const qw = path.join(__dirname, 'output', 'quality_warnings.log');
console.log(fs.existsSync(qw) ? fs.readFileSync(qw, 'utf8').split('\n').filter(Boolean).length + ' entries' : 'none');

console.log('\n=== Hard failures ===');
const fl = path.join(__dirname, 'output', 'failed_items.log');
console.log(fs.existsSync(fl) ? (fl && fs.readFileSync(fl, 'utf8').match(/^\[.*FAILED:/gm) || []).length + ' entries' : 'none');
