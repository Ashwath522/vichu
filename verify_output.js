const fs = require('fs');
const path = require('path');

const categories = ['dining', 'living_room', 'storage', 'lighting_decor'];
const MIN_WORDS = 70, MAX_WORDS = 110;

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
  const wcs = [];
  const wordFreq = {};

  lines.forEach((line) => {
    const obj = JSON.parse(line);
    const content = obj.messages[2].content;
    const wc = countWords(content);
    wcs.push(wc);
    if (wc < MIN_WORDS || wc > MAX_WORDS) outOfRange++;
    content.toLowerCase().match(/[a-z]+/g)?.forEach((w) => {
      if (w.length > 3) wordFreq[w] = (wordFreq[w] || 0) + 1;
    });
  });

  const avg = wcs.length ? (wcs.reduce((a, b) => a + b, 0) / wcs.length).toFixed(1) : 0;
  const top10 = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);

  console.log(`\n=== ${cat}: ${lines.length} items ===`);
  console.log(`Word count: avg ${avg}, out of 70-110 range: ${outOfRange}/${lines.length}`);
  console.log(`Top 10 words:`, top10.map(([w, c]) => `${w}(${c})`).join(', '));
  console.log(`Sample (first item):`);
  console.log(JSON.parse(lines[0]).messages[2].content);
  console.log(`Sample (last item):`);
  console.log(JSON.parse(lines[lines.length - 1]).messages[2].content);
}

console.log('\n=== Quality warnings kept despite retry ===');
const qw = path.join(__dirname, 'output', 'quality_warnings.log');
console.log(fs.existsSync(qw) ? fs.readFileSync(qw, 'utf8').split('\n').filter(Boolean).length + ' entries' : 'none');

console.log('\n=== Hard failures ===');
const fl = path.join(__dirname, 'output', 'failed_items.log');
console.log(fs.existsSync(fl) ? (fl && fs.readFileSync(fl, 'utf8').match(/^\[.*FAILED:/gm) || []).length + ' entries' : 'none');
