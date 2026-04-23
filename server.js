const express = require('express');
const https = require('https');
const compression = require('compression');

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// Apply compression middleware to fix content-encoding issue
app.use(compression());

// ========== Configuration ==========
const ENT_FOLDER_ID = process.env.ENT_FOLDER_ID || '1s7nR_Y-pK-v2fQ0dSl-X3NPX-txpV5vk';
const FEED_BASE_URL = process.env.FEED_BASE_URL || 'https://entpodcast.zeabur.app';
const SHOW = {
  title: 'ENT Update',
  description: 'Ear, nose and throat head and neck medicine latest information. Weekly curated international literature, research progress and clinical updates for medical professionals. Content includes: otology, rhinology, laryngology, head and neck surgery, speech therapy, audiology, etc.',
  author: 'Doctor Hung Seedturtle',
  email: 'seedturtle1976@gmail.com',
  language: 'zh-tw',
  categories: ['Science', 'Health & Fitness'],
  imageUrl: process.env.COVER_IMAGE_URL || 'https://drive.google.com/uc?id=1e9NLJLoXp-vmncEtgQ6g4AmPXxaPg7r8&amp;export=download',
  link: FEED_BASE_URL,
  ownerName: 'Doctor Hung Seedturtle',
  copyright: `Copyright ${new Date().getFullYear()} ENT Update`
};

// Maton API Gateway
const MATON_KEY = process.env.MATON_API_KEY;
const fs = require('fs');
const path = require('path');

// ========== Google Drive Query (Maton Gateway) ==========
function driveRequest(path, params) {
  return new Promise((resolve, reject) => {
    const queryString = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const options = {
      hostname: 'gateway.maton.ai',
      path: `/google-drive${path}?${queryString}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${MATON_KEY}`
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => reject(new Error('Drive request timeout')));
    req.end();
  });
}

// ========== Google Drive Upload (Maton Gateway) ==========
function uploadFileToDrive(localFilePath, remoteFileName) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(localFilePath);
    const fileSize = fs.statSync(localFilePath).size;

    const boundary = '-------MatonUploadBoundary' + Date.now();
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--\r\n`;

    const metadata = {
      name: remoteFileName,
      parents: [process.env.ENT_FOLDER_ID]
    };

    const bodyParts = [];

    // Part 1: metadata
    bodyParts.push(
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata)
    );

    // Part 2: file content
    bodyParts.push(
      delimiter +
      'Content-Type: audio/mpeg\r\n' +
      'Content-Transfer-Encoding: binary\r\n' +
      '\r\n'
    );

    // We'll write the header parts first, then pipe the file, then the closing delimiter
    const header = bodyParts.join('');
    const footer = closeDelimiter;

    // Calculate total length (approximate, but we can stream without knowing exact)
    // For simplicity, we'll read the file into memory (file is small ~2MB)
    fs.readFile(localFilePath, (err, fileData) => {
      if (err) {
        return reject(new Error(`Failed to read file: ${err.message}`));
      }

      const body = Buffer.concat([
        Buffer.from(header),
        fileData,
        Buffer.from(footer)
      ]);

      const options = {
        hostname: 'gateway.maton.ai',
        path: '/google-drive/drive/v3/files?uploadType=multipart',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MATON_KEY}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': body.length
        }
      };

      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve(result);
          } catch (e) {
            reject(new Error('JSON parse error in upload response: ' + e.message));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => reject(new Error('Upload request timeout')));
      req.write(body);
      req.end();
    });
  });
}

async function getPodcastFiles() {
  const folderId = ENT_FOLDER_ID;
  const query = `mimeType='audio/mpeg' and '${folderId}' in parents and trashed=false`;

  const result = await driveRequest('/drive/v3/files', {
    fields: 'files(id,name,mimeType,createdTime,modifiedTime,size,description)',
    q: query,
    pageSize: 50
  });
  return result.files || [];
}

// ========== MP3 Public URL (prefer reading description) ==========
function getAudioUrl(file) {
  if (file.description && file.description.startsWith('http')) {
    return file.description;
  }
  return `https://drive.google.com/uc?id=${file.id}&export=download`;
}

// ========== RSS XML Generation ==========
function generateRSS(files) {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title><![CDATA[${SHOW.title}]]></title>\n    <link>${SHOW.link}</link>\n    <description><![CDATA[${SHOW.description}]]></description>\n    <language>${SHOW.language}</language>\n    <copyright>${SHOW.copyright}</copyright>\n    <itunes:author>${SHOW.author}</itunes:author>\n    <itunes:summary><![CDATA[${SHOW.description}]]></itunes:summary>\n    <itunes:owner>\n      <itunes:name>${SHOW.ownerName}</itunes:name>\n      <itunes:email>${SHOW.email}</itunes:email>\n    </itunes:owner>\n    <itunes:explicit>false</itunes:explicit>\n    <itunes:category text="Science"/>\n    <itunes:category text="Health & Fitness"/>\n    <atom:link href="${FEED_BASE_URL}/feed.xml" rel="self" type="application/rss+xml"/>\n`;

  if (SHOW.imageUrl) {
    xml += `    <itunes:image href="${SHOW.imageUrl}"/>\n`;
    xml += `    <image><url>${SHOW.imageUrl}</url><title>${SHOW.title}</title><link>${SHOW.link}</link></image>\n`;
  }

  xml += `    <ttl>60</ttl>\n`;

  files.forEach((file, index) => {
    const dateMatch = file.name.match(/(\d{8})/);
    const dateStr = dateMatch ? dateMatch[1] : '';
    const pubDate = file.modifiedTime ? new Date(file.modifiedTime).toUTCString() : new Date().toUTCString();
    const size = parseInt(file.size || 0);
    const durationSecs = Math.round(size / (128 * 1024 / 8));
    const episodeNum = files.length - index;
    const episodeTitle = dateStr
      ? `Episode ${episodeNum} | ${dateStr.slice(0,4)}/${dateStr.slice(4,6)}/${dateStr.slice(6,8)}`
      : `Episode ${episodeNum}`;

    xml += `    <item>\n      <title><![CDATA[${episodeTitle}]]></title>\n      <description><![CDATA[ENT Update, ${episodeTitle}. ENT Head and Neck Medicine latest information.]]></description>\n      <pubDate>${pubDate}</pubDate>\n      <enclosure url="${getAudioUrl(file)}" type="audio/mpeg" length="${size}"/>\n      <guid isPermaLink="false">${file.id}</guid>\n      <itunes:title>${episodeTitle}</itunes:title>\n      <itunes:duration>${durationSecs}</itunes:duration>\n      <itunes:explicit>false</itunes:explicit>\n    </item>\n`;
  });

  xml += `  </channel>\n</rss>`;
  return xml;
}

// ========== Routes ==========
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/feed.xml', async (req, res) => {
  try {
    const files = await getPodcastFiles();
    const xml = generateRSS(files);
    const contentLength = Buffer.byteLength(xml, 'utf8');

    // Determine Last-Modified header: use the latest file's modifiedTime or current time
    let lastModified = new Date().toUTCString();
    if (files.length > 0) {
      let latest = new Date(0); // epoch
      files.forEach(f => {
        const m = new Date(f.modifiedTime);
        if (m > latest) latest = m;
      });
      if (latest > new Date(0)) {
        lastModified = latest.toUTCString();
      }
    }

    res.set({
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Content-Length': contentLength,
      'Cache-Control': 'public, max-age=3600',
      'Last-Modified': lastModified
    });
    res.send(xml);
    console.log(`[${new Date().toISOString()}] ENT RSS generated: ${files.length} episodes, ${contentLength} bytes`);
  } catch (err) {
    console.error('ENT RSS error:', err.message);
    res.status(500).send(`<!-- RSS Error: ${err.message} --> `);
  }
});

app.get('/episodes', async (req, res) => {
  try {
    const files = await getPodcastFiles();
    res.json({ count: files.length, episodes: files.map(f => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, description: f.description })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ENT Update RSS Server started!`);
  console.log(`Feed URL: ${FEED_BASE_URL}/feed.xml`);
});
