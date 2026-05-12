const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const compression = require('compression');

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// Apply compression middleware to fix content-encoding issue
app.use(compression());
app.use('/static', express.static(path.join(__dirname, 'static')));

// ========== Configuration ==========
const ENT_FOLDER_ID = process.env.ENT_FOLDER_ID || '1s7nR_Y-pK-v2fQ0dSl-X3NPX-txpV5vk';
const FEED_BASE_URL = process.env.FEED_BASE_URL || 'https://entpodcast.zeabur.app';
const SHOW = {
  title: 'ENT Update',
  description: 'Ear, nose and throat head and neck medicine latest information. Weekly curated international literature, research progress and clinical updates for medical professionals. Content includes: otology, rhinology, laryngology, head and neck surgery, speech therapy, audiology, etc.',
  subtitle: 'Latest ENT research and clinical updates',
  author: '洪士涵醫師',
  email: 'seedturtle1976@gmail.com',
  language: 'zh-TW',
  imageUrl: process.env.COVER_IMAGE_URL || FEED_BASE_URL + '/static/ent-update-cover-3000.jpg',
  link: FEED_BASE_URL,
  ownerName: '洪士涵醫師',
  copyright: `Copyright ${new Date().getFullYear()} ENT Update`
};

// Maton API Gateway
const MATON_KEY = process.env.MATON_API_KEY;
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
        path: '/google-drive/upload/drive/v3/files?uploadType=multipart',
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
    pageSize: 50,
    orderBy: 'createdTime desc'
  });
  return result.files || [];
}

// ========== Audio Proxy (stream from Google Drive via Maton) ==========
// Support both /audio/:fileId and /audio/:fileId.mp3
app.get('/audio/:fileId', async (req, res) => {
  // Strip .mp3 extension if present
  req.params.fileId = req.params.fileId.replace(/\.mp3$/i, '');
  try {
    const { fileId } = req.params;
    const file = await driveRequest(`/drive/v3/files/${fileId}`, {
      fields: 'name,mimeType,size'
    });

    const drivePath = `/google-drive/drive/v3/files/${fileId}?alt=media`;
    const driveHeaders = { 'Authorization': `Bearer ${MATON_KEY}` };

    // Forward Range header if present (byte-range support for Apple)
    if (req.headers.range) {
      driveHeaders['Range'] = req.headers.range;
    }

    const fileStream = https.request({
      hostname: 'gateway.maton.ai',
      path: drivePath,
      method: 'GET',
      headers: driveHeaders
    }, (drivesRes) => {
      const statusCode = drivesRes.statusCode || 200;
      const headers = {
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400'
      };

      // Forward Content-Range for 206 partial responses (Apple Podcast uses byte-range seeking)
      if (drivesRes.headers['content-range']) {
        headers['Content-Range'] = drivesRes.headers['content-range'];
        // Calculate proper Content-Length from Content-Range when Maton doesn't return it
        const rangeMatch = drivesRes.headers['content-range'].match(/bytes\s+(\d+)-(\d+)/);
        if (rangeMatch) {
          headers['Content-Length'] = (parseInt(rangeMatch[2]) - parseInt(rangeMatch[1]) + 1).toString();
        }
      } else if (drivesRes.headers['content-length']) {
        headers['Content-Length'] = drivesRes.headers['content-length'];
      } else if (file.size) {
        headers['Content-Length'] = file.size;
      }

      res.status(statusCode).set(headers);
      drivesRes.pipe(res);
    });

    fileStream.on('error', (err) => {
      console.error('Audio proxy error:', err.message);
      if (!res.headersSent) res.status(500).send('Audio stream error');
    });

    fileStream.setTimeout(30000, () => {
      fileStream.destroy();
      if (!res.headersSent) res.status(504).send('Audio stream timeout');
    });

    fileStream.end();
  } catch (err) {
    console.error('Audio proxy fetch error:', err.message);
    if (!res.headersSent) res.status(500).send('File not found');
  }
});

// ========== MP3 Public URL (use local proxy) ==========
function getAudioUrl(file) {
  if (file.description && file.description.startsWith('http')) {
    return file.description;
  }
  return `${FEED_BASE_URL}/audio/${file.id}.mp3`;
}

// Clean text: remove Unicode replacement characters and normalize
function cleanText(text) {
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
    .replace(/<\/channel>/gi, '')
    .replace(/<item[^>]*>/gi, '')
    .replace(/<\/item>/gi, '')
    // Strip JSON artifacts like ,"summary":
    .replace(/,\x22[a-zA-Z]+\x22\s*:\s*\x22/g, '')
    .trim();
}

// ========== Duration Format Helper ==========
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  if (m > 0) return `${m}:${String(s).padStart(2,'0')}`;
  return `0:${String(s).padStart(2,'0')}`;
}

// ========== RSS XML Generation ==========
function generateRSS(files) {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:podcast="https://podcastindex.org/namespace/1.0">\n  <channel>\n    <title><![CDATA[${SHOW.title}]]></title>\n    <link>${SHOW.link}</link>\n    <description><![CDATA[${SHOW.description}]]></description>\n    <language>${SHOW.language}</language>\n    <copyright>${SHOW.copyright}</copyright>\n    <itunes:author>${SHOW.author}</itunes:author>\n    <itunes:subtitle>${SHOW.subtitle}</itunes:subtitle>\n    <itunes:summary><![CDATA[${SHOW.description}]]></itunes:summary>\n    <itunes:type>episodic</itunes:type>\n    <itunes:owner>\n      <itunes:name>${SHOW.ownerName}</itunes:name>\n      <itunes:email>${SHOW.email}</itunes:email>\n    </itunes:owner>\n    <itunes:explicit>false</itunes:explicit>\n    <itunes:category text="Science"/>\n    <itunes:category text="Health &amp; Fitness"/>\n    <atom:link href="${FEED_BASE_URL}/feed.xml" rel="self" type="application/rss+xml"/>\n`;

  if (SHOW.imageUrl) {
    const imgUrl = SHOW.imageUrl.replace(/&/g, '&amp;');
    xml += `    <itunes:image href="${imgUrl}"/>\n`;
    xml += `    <image><url>${imgUrl}</url><title>${SHOW.title}</title><link>${SHOW.link}</link></image>\n`;
  }

  xml += `    <ttl>60</ttl>\n`;

  files.forEach((file, index) => {
    const dateMatch = file.name.match(/(\d{8})/);
    let dateStr = dateMatch ? dateMatch[1] : '';
    if (!dateStr && file.createdTime) {
      dateStr = file.createdTime.slice(0,10).replace(/-/g, '');
    }
    const pubDate = file.modifiedTime ? new Date(file.modifiedTime).toUTCString() : new Date().toUTCString();
    const size = parseInt(file.size || 0);
    const durationSecs = Math.round(size / (128 * 1000 / 8));
    const episodeNum = files.length - index;
    const isSpecial = file.name.includes('Special') || (file.description && file.description.includes('特輯'));
    const suffix = isSpecial ? '-Special' : '';
    const episodeTitle = dateStr
      ? `Episode ${episodeNum}${suffix} | ${dateStr.slice(0,4)}/${dateStr.slice(4,6)}/${dateStr.slice(6,8)}`
      : `Episode ${episodeNum}${suffix}`;
    const audioUrl = getAudioUrl(file).replace(/&/g, '&amp;');
    const rawDesc = file.description && file.description.trim()
      ? file.description.trim()
      : `ENT Update, ${episodeTitle}. ENT Head and Neck Medicine latest information.`;
    const episodeDesc = cleanText(rawDesc);
    const episodeLink = `${FEED_BASE_URL}/audio/${file.id}.mp3`;

    xml += `    <item>\n      <title><![CDATA[${episodeTitle}]]></title>\n      <link>${episodeLink}</link>\n      <description><![CDATA[${episodeDesc}]]></description>\n      <itunes:summary><![CDATA[${episodeDesc}]]></itunes:summary>\n      <pubDate>${pubDate}</pubDate>\n      <enclosure url="${audioUrl}" type="audio/mpeg" length="${size}"/>\n      <guid isPermaLink="false">${file.id}</guid>\n      <itunes:title>${episodeTitle}</itunes:title>\n      <itunes:episodeType>full</itunes:episodeType>\n      <itunes:duration>${formatDuration(durationSecs)}</itunes:duration>\n      <itunes:explicit>false</itunes:explicit>\n    </item>\n`;
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
