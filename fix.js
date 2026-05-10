const fs = require('fs');
let content = fs.readFileSync('server.js', 'utf8');

// Replace cleanText function
const oldClean = `function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/\uFFFD/g, '')
    .replace(/\uFFFD\uFFFD/g, '')
    .replace(/[\uDC00-\uDFFF]/g, '')
    .replace(/[\uD800-\uDBFF][^\uDC00-\uDFFF]/g, '')
    .replace(/[<>]/g, '')
    .trim();
}`;

const newClean = `function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/\uFFFD/g, '')
    .replace(/\uFFFD\uFFFD/g, '')
    .replace(/[\uDC00-\uDFFF]/g, '')
    .replace(/[\uD800-\uDBFF][^\uDC00-\uDFFF]/g, '')
    .replace(/[<>]/g, '')
    // Strip embedded XML/RSS declarations
    .replace(/<\?xml[^>]*\?>\s*/gi, '')
    .replace(/<rss[^>]*>/gi, '')
    .replace(/<\/rss>/gi, '')
    .replace(/<channel[^>]*>/gi, '')
    .replace/<\/channel>/gi, '')
    .replace(/<item[^>]*>/gi, '')
    .replace(/<\/item>/gi, '')
    // Strip JSON artifacts like ,"summary":"
    .replace(/,\x22[a-zA-Z]+\x22\s*:\s*\x22/g, '')
    .trim();
}`;

content = content.replace(oldClean, newClean);

// Add express.static for /static
content = content.replace(
  'app.use(compression());',
  'app.use(compression());\napp.use(\'/static\', express.static(path.join(__dirname, \'static\')));'
);

// Update cover image URL
content = content.replace(
  "imageUrl: process.env.COVER_IMAGE_URL || 'https://lh3.googleusercontent.com/d/1WEN1qivEXaoWYOs6d6KTl7YCee4xABI6=s3000'",
  "imageUrl: process.env.COVER_IMAGE_URL || FEED_BASE_URL + '/static/ent-update-cover-3000.jpg'"
);

fs.writeFileSync('server.js', content);
console.log('Done');
