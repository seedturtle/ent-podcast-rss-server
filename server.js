/**
 * ENT Update Podcast RSS Feed Server
 * 
 * 查詢 Google Drive ENT_update 資料夾，動態生成 RSS XML
 * 部署到 Zeabur，透過 /feed.xml 供 Podcast 平台訂閱
 */

const express = require('express');
const https = require('https');

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// ========== 設定區 ==========
const ENT_FOLDER_ID = process.env.ENT_FOLDER_ID || '1yB8xGj5eF3x9XwKp2r7TvQa4m6n8LsC'; // KIRITU/ENT_update
const FEED_BASE_URL = process.env.FEED_BASE_URL || 'https://entupdate.zeabur.app';
const SHOW = {
  title: 'ENT Update',
  description: '耳鼻喉頭頸醫學最新資訊。每週為專業醫療人員整理國際文獻、研究進展與臨床新知。內容涵蓋：耳科、鼻科、喉科、頭頸外科、語言治療、聽力學等領域。',
  author: '洪醫師 Seedturtle',
  email: 'seedturtle1976@gmail.com',
  language: 'zh-tw',
  categories: ['Science', 'Medicine', 'Health & Fitness'],
  imageUrl: process.env.COVER_IMAGE_URL || 'https://agent-cdn.minimax.io/mcp/cdn_upload/495582502232113157/382781085360351/1776820003_xxxxxxxxxxx.png',
  link: FEED_BASE_URL,
  ownerName: '洪醫師 Seedturtle',
  copyright: `Copyright ${new Date().getFullYear()} ENT Update`
};

// Maton API Gateway
const MATON_KEY = process.env.MATON_API_KEY;
const CONN_ID   = process.env.MATON_CONN_ID || 'aa84aef8-287a-4271-a4b7-26a67b0c6adf';

// ========== Google Drive 查詢（Maton Gateway）==========
function driveRequest(path, params = {}) {
  return new Promise((resolve, reject) => {
    const queryParts = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    const qs = queryParts.length ? '?' + queryParts.join('&') : '';
    const options = {
      hostname: 'gateway.maton.ai',
      path: `/google-drive${path}${qs}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${MATON_KEY}`,
        'Maton-Connection': CONN_ID
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
    req.setTimeout(10000, () => reject(new Error('Drive request timeout')));
    req.end();
  });
}

async function getPodcastFiles() {
  const result = await driveRequest('/drive/v3/files', {
    fields: 'files(id,name,mimeType,createdTime,modifiedTime,size,description)',
    q: `mimeType='audio/mpeg' and '${ENT_FOLDER_ID}' in parents and trashed=false`,
    orderBy: 'modifiedTime desc',
    pageSize: 50
  });
  return result.files || [];
}

// ========== MP3 公開網址（優先讀取 description）==========
function getAudioUrl(file) {
  if (file.description && file.description.startsWith('http')) {
    return file.description;
  }
  return `https://drive.google.com/uc?id=${file.id}&export=download`;
}

// ========== RSS XML 生成 ==========
function generateRSS(files) {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title><![CDATA[${SHOW.title}]]></title>
    <link>${SHOW.link}</link>
    <description><![CDATA[${SHOW.description}]]></description>
    <language>${SHOW.language}</language>
    <copyright>${SHOW.copyright}</copyright>
    <itunes:author>${SHOW.author}</itunes:author>
    <itunes:summary><![CDATA[${SHOW.description}]]></itunes:summary>
    <itunes:owner>
      <itunes:name>${SHOW.ownerName}</itunes:name>
      <itunes:email>${SHOW.email}</itunes:email>
    </itunes:owner>
    <itunes:explicit>false</itunes:explicit>
    <itunes:category text="Science"/>
    <itunes:category text="Medicine"/>
    <atom:link href="${FEED_BASE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
`;

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
      ? `第${episodeNum}集｜${dateStr.slice(0,4)}/${dateStr.slice(4,6)}/${dateStr.slice(6,8)}`
      : `第${episodeNum}集`;

    xml += `    <item>
      <title><![CDATA[${episodeTitle}]]></title>
      <description><![CDATA[ENT Update，${episodeTitle}。耳鼻喉頭頸醫學最新資訊。]]></description>
      <pubDate>${pubDate}</pubDate>
      <enclosure url="${getAudioUrl(file)}" type="audio/mpeg" length="${size}"/>
      <guid isPermaLink="false">${file.id}</guid>
      <itunes:title>${episodeTitle}</itunes:title>
      <itunes:duration>${durationSecs}</itunes:duration>
      <itunes:explicit>false</itunes:explicit>
    </item>\n`;
  });

  xml += `  </channel>\n</rss>`;
  return xml;
}

// ========== 路由 ==========
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/feed.xml', async (req, res) => {
  try {
    const files = await getPodcastFiles();
    const xml = generateRSS(files);
    res.set({
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    });
    res.send(xml);
    console.log(`[${new Date().toISOString()}] ENT RSS generated: ${files.length} episodes`);
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
  console.log(`🏥 ENT Update RSS Server 啟動！`);
  console.log(`📡 Feed URL: ${FEED_BASE_URL}/feed.xml`);
});
