'use strict';

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// Global Logging
app.use((req, res, next) => {
    if (req.url !== '/') {
        console.log(`ðŸ“¡ [${new Date().toLocaleTimeString()}] ${req.method} ${req.url} from ${req.ip}`);
    }
    next();
});

const upload = multer({ storage: multer.memoryStorage() });

// ===================== DATA STORE =====================
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TG_CONTACTS_FILE = path.join(DATA_DIR, 'tg_contacts.json');

function loadJSON(filePath, defaultVal = {}) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
    } catch (e) {
        console.log(`âš ï¸ Failed to load ${filePath}:`, e.message);
    }
    return defaultVal;
}

function saveJSON(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.log(`âŒ Failed to save ${filePath}:`, e.message);
    }
}

let tgContacts = loadJSON(TG_CONTACTS_FILE, {});

// ===================== ENV & CONFIG =====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID;
const LOG_GROUP_ID = process.env.LOG_GROUP_ID || ADMIN_GROUP_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || '';
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || '';

const PORT = process.env.PORT || 10000;
let WA_BRIDGE_URL = process.env.WA_BRIDGE_URL || '';
const WA_BRIDGE_SECRET = process.env.WA_BRIDGE_SECRET || '';

console.log(`ðŸ“¡ Initial WA Bridge URL: ${WA_BRIDGE_URL || 'NOT SET'}`);

// Config for TG Player Group
const TG_CONFIG_FILE = path.join(DATA_DIR, 'tg_config.json');
let tgConfig = loadJSON(TG_CONFIG_FILE, { playerGroupId: null });
function saveTgConfig() { saveJSON(TG_CONFIG_FILE, tgConfig); }

// Global data stores for dashboard
let waContactsSync = {};
let waActiveSessions = 0;
let lastSyncTime = null;
const STT_LANGUAGE = (process.env.STT_LANGUAGE || 'id').toLowerCase();

// --- HUMAN TAKEOVER STATE ---
let humanTakeovers = {}; // { jid: { adminId, adminName, startTime } }




if (!TELEGRAM_BOT_TOKEN || !ADMIN_GROUP_ID || !LOG_GROUP_ID) {
    console.error('âŒ Missing ENV: TELEGRAM_BOT_TOKEN, ADMIN_GROUP_ID, LOG_GROUP_ID');
    process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

function nowISO() {
    return new Date().toISOString();
}

function safeStr(v) {
    return (v === undefined || v === null) ? '' : String(v);
}

// ===================== TRIGGERS =====================
function matchTrigger(rawText) {
    return null;
}

const chatHistories = {};
const MAX_HISTORY = 10;

// ===================== GEMINI AI =====================
async function getGeminiResponse(prompt, targetId = 'unknown', pushName = 'Kakak') {
    if (!GEMINI_API_KEY) return 'Maaf kak, Melody lagi istirahat sebentar ya. 🙏';

    // Ambil profil member (jika ada) dari WA sync atau TG
    const waContact = waContactsSync[targetId] || {};
    const points = waContact.points || 0;
    const realName = pushName !== 'Kakak' ? pushName : (waContact.name || 'Kakak');

    // Inisialisasi history jika belum ada
    if (!chatHistories[targetId]) chatHistories[targetId] = [];

    // Read Knowledge Base
    let knowledge = '';
    try {
        const kPath = path.join(__dirname, 'data', 'melody_knowledge.txt');
        if (fs.existsSync(kPath)) knowledge = fs.readFileSync(kPath, 'utf-8');
    } catch (e) { }

    const systemPrompt = `Kamu adalah Melody, CS ICE3BET yang sangat ramah, ceria, dan membantu. 
Knowledge Base: ${knowledge}

TUGAS: Jawab member dengan natural. Jika member tanya depo/wd/link/rtp, arahkan sesuai knowledge. Jika member marah, tenangkan. 
Gunakan bahasa yang gaul dan sopan (Kak, Bosku, Abangku).

ATURAN FORMAT PENTING:
- JANGAN PERNAH gunakan format markdown link seperti [text](url). Tulis URL langsung saja tanpa format apapun.
- JANGAN gunakan format bold markdown seperti **text**. Gunakan *text* saja untuk penekanan.
- JANGAN gunakan heading (#), tabel, atau format markdown lainnya.
- Tulis plain text saja yang cocok untuk WhatsApp dan Telegram.

--- DATA MEMBER ---
Nama Member: ${realName}
Poin Loyalitas (Keaktifan): ${points}`;

    const contents = [];
    chatHistories[targetId].forEach(h => {
        contents.push({
            role: h.role,
            parts: [{ text: h.text }]
        });
    });

    contents.push({
        role: "user",
        parts: [{ text: prompt }]
    });

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const res = await axios.post(url, {
            system_instruction: {
                parts: { text: systemPrompt }
            },
            contents: contents,
            generationConfig: {
                temperature: 0.7
            }
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });

        let reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Ada yang bisa Melody bantu lagi kak?';
        
        reply = reply.replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$2');
        reply = reply.replace(/\*\*([^*]+)\*\*/g, '*$1*');
        reply = reply.replace(/\*\*\*([^*]+)\*\*\*/g, '*$1*');
        
        chatHistories[targetId].push({ role: 'user', text: prompt });
        chatHistories[targetId].push({ role: 'model', text: reply });
        
        if (chatHistories[targetId].length > MAX_HISTORY * 2) {
            chatHistories[targetId] = chatHistories[targetId].slice(-(MAX_HISTORY * 2));
        }

        return reply;
    } catch (e) {
        console.error('❌ GEMINI API ERROR:', e.message);
        if (e.response) {
            console.error('❌ Status:', e.response.status);
            console.error('❌ Data:', JSON.stringify(e.response.data));
        }
        return 'Maaf kak, ada kendala teknis sedikit. Kabari Melody lagi ya!';
    }
}

// ===================== DASHBOARD UI =====================
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Melody CRM Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
    <style>
        :root { --bg: #0f172a; --card: #1e293b; --accent: #38bdf8; --text: #f8fafc; --muted: #94a3b8; }
        * { box-sizing: border-box; }
        body { font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); margin: 0; display: flex; min-height: 100vh; }
        
        /* Sidebar */
        aside { width: 260px; background: #020617; padding: 2rem; display: flex; flex-direction: column; border-right: 1px solid #1e293b; }
        aside h1 { color: var(--accent); font-size: 1.5rem; margin-bottom: 2rem; }
        nav a { color: var(--muted); text-decoration: none; padding: 0.8rem 1rem; border-radius: 8px; margin-bottom: 0.5rem; display: block; transition: 0.3s; }
        nav a.active, nav a:hover { background: #1e293b; color: white; }
        
        /* Main */
        main { flex: 1; padding: 2rem; overflow-y: auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
        .card { background: var(--card); padding: 1.5rem; border-radius: 16px; border: 1px solid #334155; }
        .card h3 { color: var(--muted); font-size: 0.9rem; margin-top: 0; }
        .card p { font-size: 2rem; font-weight: 600; margin: 0.5rem 0 0; }
        
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; background: var(--card); border-radius: 12px; overflow: hidden; }
        th, td { padding: 1rem; text-align: left; border-bottom: 1px solid #334155; }
        th { background: #1e293b; color: var(--muted); font-weight: 400; font-size: 0.85rem; }
        tr:last-child td { border-bottom: none; }
        .badge { padding: 4px 8px; border-radius: 6px; font-size: 0.75rem; background: #075985; color: #7dd3fc; }
        
        /* Login */
        #login-overlay { position: fixed; inset: 0; background: var(--bg); display: flex; align-items: center; justify-content: center; z-index: 100; }
        .login-box { background: var(--card); padding: 2.5rem; border-radius: 20px; width: 100%; max-width: 400px; text-align: center; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
        input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; margin: 1rem 0; }
        button { width: 100%; padding: 12px; background: var(--accent); color: #020617; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; }
    </style>
</head>
<body>
    <div id="login-overlay">
        <div class="login-box">
            <h2>ðŸ” Dashboard Login</h2>
            <p style="color: var(--muted)">Masukkan password dashboard kamu</p>
            <input type="password" id="pw" placeholder="Password">
            <button onclick="login()">Buka Dashboard</button>
        </div>
    </div>

    <aside>
        <h1>Melody CRM</h1>
        <nav>
            <a href="#" class="active">ðŸ  Dashboard</a>
            <a href="#">ðŸ‘¥ Member WA</a>
            <a href="#">ðŸ¤– Member TG</a>
            <a href="#">ðŸ’° Riwayat Depo</a>
        </nav>
    </aside>

    <main>
        <div class="header">
            <div>
                <h2 style="margin:0">ðŸ‘‹ Halo Admin</h2>
                <p style="color: var(--muted); margin:0">Selamat datang di pusat kendali Melody</p>
            </div>
            <div id="sync-info" style="font-size: 0.8rem; color: var(--muted)">Sync: -</div>
        </div>

        <div class="stats-grid">
            <div class="card"><h3>Total Member WA</h3><p id="wa-count">0</p></div>
            <div class="card"><h3>Total Member TG</h3><p id="tg-count">0</p></div>
            <div class="card"><h3>Sesi Aktif (WA)</h3><p id="active-count">0</p></div>
        </div>

        <div class="card">
            <h3 style="margin-bottom: 1.5rem">Recent Active Members (WhatsApp)</h3>
            <table>
                <thead>
                    <tr><th>Nama</th><th>WhatsApp JID</th><th>Terakhir Dilihat</th><th>Poin</th></tr>
                </thead>
                <tbody id="contact-list">
                    <!-- Data will load here -->
                </tbody>
            </table>
        </div>
    </main>

    <script>
        let auth = localStorage.getItem('dash_pw');
        if(auth) document.getElementById('login-overlay').style.display = 'none';

        function login() {
            const pw = document.getElementById('pw').value;
            localStorage.setItem('dash_pw', pw);
            location.reload();
        }

        async function loadData() {
            try {
                const res = await fetch('/api/stats?pw=' + auth);
                const data = await res.json();
                if(!data.ok) {
                    localStorage.removeItem('dash_pw');
                    document.getElementById('login-overlay').style.display = 'flex';
                    return;
                }

                document.getElementById('wa-count').innerText = Object.keys(data.waContacts).length;
                document.getElementById('tg-count').innerText = data.tgCount;
                document.getElementById('active-count').innerText = data.activeSessions;
                document.getElementById('sync-info').innerText = 'Last Sync: ' + data.lastSync;

                const list = document.getElementById('contact-list');
                list.innerHTML = '';
                
                // Sort by lastSeen
                const sorted = Object.entries(data.waContacts).sort((a,b) => new Date(b[1].lastSeen) - new Date(a[1].lastSeen)).slice(0, 10);
                
                sorted.forEach(([jid, c]) => {
                    const row = '<tr>' +
                        '<td><b>' + (c.name || 'Unknown') + '</b></td>' +
                        '<td style="color:var(--muted)">' + jid.split('@')[0] + '</td>' +
                        '<td>' + new Date(c.lastSeen).toLocaleString() + '</td>' +
                        '<td><span class="badge">' + (c.points || 0) + ' LP</span></td>' +
                    '</tr>';
                    list.innerHTML += row;
                });

            } catch(e) {}
        }

        setInterval(loadData, 5000);
        loadData();
    </script>
</body>
</html>
`;

// ===================== TG MEDIA HELPERS =====================
async function tgCall(method, data, opts = {}) {
    const url = `${TG_API}/${method}`;
    try {
        const res = await axios.post(url, data, { timeout: 30000, ...opts });
        return res.data;
    } catch (e) {
        console.error(`âŒ tgCall ${method} failed:`, e.response?.data || e.message);
        return null;
    }
}

async function tgSendText(chatId, text, extra = {}) {
    if (!text) return null;

    // Bersihkan karakter HTML yang sering bikin error
    const cleanText = text
        .replace(/<(?!\/?(b|i|u|s|code|pre|a|em|strong|ins|del|tg-spoiler|tg-emoji))[^>]+>/g, '') // Hapus tag tak dikenal
        .trim();

    // Telegram punya batas 4096 karakter. Kita bagi per 4000 saja biar aman.
    if (cleanText.length > 4000) {
        const chunks = cleanText.match(/[\s\S]{1,4000}/g) || [];
        for (const chunk of chunks) {
            await tgCall('sendMessage', {
                chat_id: chatId,
                text: chunk,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                ...extra
            });
            await new Promise(r => setTimeout(r, 500)); // Jeda sedikit agar tidak kena rate limit
        }
        return { ok: true };
    }

    return tgCall('sendMessage', {
        chat_id: chatId,
        text: cleanText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra
    });
}

async function tgSendPhoto(chatId, buffer, filename, caption, extra = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    if (extra.reply_markup) form.append('reply_markup', JSON.stringify(extra.reply_markup));
    form.append('photo', buffer, { filename: filename || 'photo.jpg' });

    try {
        const res = await axios.post(`${TG_API}/sendPhoto`, form, {
            headers: form.getHeaders(),
            timeout: 30000
        });
        return res.data;
    } catch (e) {
        console.error('âŒ tgSendPhoto failed', e.response?.data || e.message);
        return null;
    }
}

async function tgSendDocument(chatId, buffer, filename, caption, extra = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    if (extra.reply_markup) form.append('reply_markup', JSON.stringify(extra.reply_markup));
    form.append('document', buffer, { filename: filename || 'document.bin' });

    try {
        const res = await axios.post(`${TG_API}/sendDocument`, form, {
            headers: form.getHeaders(),
            timeout: 45000
        });
        return res.data;
    } catch (e) {
        console.error('âŒ tgSendDocument failed', e.response?.data || e.message);
        return null;
    }
}

async function tgSendVoice(chatId, buffer, filename, caption) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append('voice', buffer, { filename: filename || 'voice.ogg' });

    try {
        const res = await axios.post(`${TG_API}/sendVoice`, form, {
            headers: form.getHeaders(),
            timeout: 45000
        });
        return res.data;
    } catch (e) {
        console.error('âŒ tgSendVoice failed', e.response?.data || e.message);
        return null;
    }
}

async function tgGetFileLink(fileId) {
    const info = await tgCall('getFile', { file_id: fileId });
    const filePath = info?.result?.file_path;
    if (!filePath) return null;
    return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
}

// ===================== ELEVENLABS (STT & TTS) =====================
async function elevenTTS(text) {
    if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) return null;

    // NOTE: endpoint ElevenLabs bisa berubah tergantung versi. Ini dibuat stabil untuk yang umum dipakai.
    // Kalau akun kamu pakai endpoint berbeda, tinggal ganti URL saja.
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`;

    try {
        const res = await axios.post(
            url,
            {
                text,
                model_id: 'eleven_turbo_v2', // kamu bisa ganti ke model lain yang tersedia di akun
                voice_settings: { stability: 0.5, similarity_boost: 0.7 }
            },
            {
                headers: {
                    'xi-api-key': ELEVEN_API_KEY,
                    'Content-Type': 'application/json'
                },
                responseType: 'arraybuffer',
                timeout: 45000
            }
        );
        return Buffer.from(res.data);
    } catch (e) {
        console.error('âŒ Eleven TTS failed', e.response?.data || e.message);
        return null;
    }
}

async function elevenSTTFromOgg(oggBuffer) {
    if (!ELEVEN_API_KEY) return null;

    // Endpoint STT ElevenLabs juga tergantung akun/fitur. Ini template paling umum.
    // Jika di akun kamu STT tidak aktif, fungsi ini akan gagal (wajar).
    const url = `https://api.elevenlabs.io/v1/speech-to-text`;

    const form = new FormData();
    form.append('audio', oggBuffer, { filename: 'audio.ogg' });
    form.append('model_id', 'scribe_v1');
    form.append('language_code', STT_LANGUAGE);

    try {
        const res = await axios.post(url, form, {
            headers: { ...form.getHeaders(), 'xi-api-key': ELEVEN_API_KEY },
            timeout: 60000
        });
        const text = res.data?.text || res.data?.transcript;
        return text ? String(text).trim() : null;
    } catch (e) {
        console.error('âŒ Eleven STT failed', e.response?.data || e.message);
        return null;
    }
}

// ===================== LOGGING =====================
function fmtBlock(title, lines) {
    return [
        `<b>${title}</b>`,
        ...lines.map(x => `â€¢ ${x}`)
    ].join('\n');
}

async function logToGroup(title, lines) {
    const msg = fmtBlock(title, lines);
    await tgSendText(LOG_GROUP_ID, msg);
}

// ===================== ADMIN TICKETS =====================
function extractMetaFromText(text) {
    const t = (text || '').replace(/<[^>]+>/g, ''); // Strip ALL HTML tags first
    const getLine = (key) => {
        const re = new RegExp(`${key}\\s*:\\s*(.+)`, 'i');
        const m = t.match(re);
        return m ? m[1].trim() : '';
    };

    return {
        TARGET: getLine('TARGET'),
        TG_CHAT_ID: getLine('TG_CHAT_ID'),
        WA_JID: getLine('WA_JID'),
        TICKET: getLine('TICKET')
    };
}

async function sendToAdminTicket(fromStr, data) {
    const isHuman = data.metaLines.some(l => l.includes('Mode: HUMAN'));
    
    const lines = [
        `🎟️ <b>TIKET BANTUAN BARU</b>`,
        `👤 ${fromStr}`,
        '',
        ...data.metaLines.map(x => `${x}`),
        '',
        ...data.contentLines
    ];

    const extra = {};
    if (!isHuman) {
        extra.reply_markup = {
            inline_keyboard: [
                [{ text: '🙋‍♂️ Ambil Tiket', callback_data: `claim_${Date.now()}` }]
            ]
        };
    }

    if (data.media) {
        if (data.media.type === 'photo') {
            await tgSendPhoto(ADMIN_GROUP_ID, data.media.buffer, data.media.filename, lines.join('\n'), extra);
        } else {
            await tgSendDocument(ADMIN_GROUP_ID, data.media.buffer, data.media.filename, lines.join('\n'), extra);
        }
    } else {
        await tgSendText(ADMIN_GROUP_ID, lines.join('\n'), extra);
    }
}

// ===================== WA BRIDGE CALL =====================
async function callWABridgeAPI(path, data = {}, method = 'POST') {
    if (!WA_BRIDGE_URL) return { ok: false, error: 'WA_BRIDGE_URL not set' };

    try {
        const config = {
            method,
            url: `${WA_BRIDGE_URL.replace(/\/$/, '')}${path}`,
            headers: WA_BRIDGE_SECRET ? { 'x-bridge-secret': WA_BRIDGE_SECRET } : {},
            timeout: 30000
        };
        if (method === 'POST') config.data = data;

        console.log(`ðŸ“¡ Calling WA Bridge: ${method} ${config.url}`);
        const res = await axios(config);
        console.log(`âœ… WA Bridge Response: OK`);
        return res.data || { ok: true };
    } catch (e) {
        console.log(`âŒ WA Bridge Error: ${e.message} | URL: ${WA_BRIDGE_URL}${path}`);
        if (e.response) console.log(`âŒ Error Data:`, JSON.stringify(e.response.data));
        return { ok: false, error: e.response?.data?.error || e.message };
    }
}

async function callWABridgeSend({ jid, text }) {
    return callWABridgeAPI('/send', { jid, text }, 'POST');
}

// ===================== WEBHOOK ROUTES =====================
app.get('/', (req, res) => res.status(200).send('OK'));

app.post('/webhook', async (req, res) => {
    // telegram webhook
    res.send('ok');

    console.log(`ðŸ“© Webhook received: ${JSON.stringify(req.body).substring(0, 200)}...`);

    if (req.body.message) {
        await handleTelegramMessage(req.body.message);
    } else if (req.body.callback_query) {
        const cq = req.body.callback_query;
        if (cq.data && cq.data.startsWith('claim_')) {
            const adminName = cq.from.first_name || 'Admin';
            const adminId = cq.from.id;

            const originalText = cq.message.text || cq.message.caption || '';

            const meta = extractMetaFromText(originalText);
            let targetId = meta.WA_JID || meta.TG_CHAT_ID;

            if (targetId) {
                humanTakeovers[targetId] = {
                    adminId: adminId,
                    adminName: adminName,
                    startTime: Date.now()
                };
                console.log(`ðŸ‘¤ Human Takeover ACTIVATED for: ${targetId} by ${adminName}`);

                // Beri tahu member (Opsional)
                if (targetId.includes('@')) { // WA
                    await callWABridgeSend({ jid: targetId, text: `ðŸ™‹â€â™‚ï¸ *Pesan kakak sedang dibantu oleh Admin ${adminName}.* Mohon ditunggu sebentar ya kak! âœ¨` });
                } else { // TG
                    await tgSendText(targetId, `ðŸ™‹â€â™‚ï¸ <b>Pesan kakak sedang dibantu oleh Admin ${adminName}.</b> Mohon ditunggu sebentar ya kak! âœ¨`);
                }
            } else {
                console.log('âš ï¸ Failed to extract targetId from ticket:', originalText);
            }

            const newText = originalText + `\n\nâœ… <b>Sedang dilayani oleh:</b> ${adminName} (AI OFF)`;

            if (cq.message.photo || cq.message.document) {
                await tgCall('editMessageCaption', {
                    chat_id: cq.message.chat.id,
                    message_id: cq.message.message_id,
                    caption: newText,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [] }
                });
            } else {
                await tgCall('editMessageText', {
                    chat_id: cq.message.chat.id,
                    message_id: cq.message.message_id,
                    text: newText,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [] }
                });
            }

            await tgCall('answerCallbackQuery', {
                callback_query_id: cq.id,
                text: 'Tiket berhasil diambil!'
            });
        }
    }
});

async function handleTelegramMessage(message) {
    const chatId = message.chat?.id;
    const chatType = message.chat?.type;

    console.log(`ðŸ“¥ Processing message from chatId: ${chatId}`);

    // 1.2) Handle Group Welcome
    if (message.new_chat_members) {
        if (tgConfig.playerGroupId && String(chatId) === String(tgConfig.playerGroupId)) {
            for (const newMember of message.new_chat_members) {
                if (newMember.is_bot) continue;
                const name = newMember.first_name || 'Kakak';
                const welcomeText = `ðŸŽ‰ <b>SELAMAT DATANG DI ICE3BET!</b> ðŸŽ‰\n\n` +
                    `Halo <b>${name}</b>! Selamat bergabung di komunitas ICE3BET. Melody siap bantu kakak setiap hari. ðŸ˜Š\n\n` +
                    `ðŸŽ <b>Promo Spesial Buat Kamu:</b> \n` +
                    `- Bonus New Member 100%\n` +
                    `- Garansi Kekalahan 100% Saldo Kembali\n\n` +
                    `ðŸš€ <b>Link Login:</b> <a href="https://cutt.ly/ice3bet-alternatif2">KLIK DI SINI</a>\n` +
                    `ðŸ“ˆ <b>Link RTP:</b> <a href="https://cutt.ly/ice3rtp">CEK RTP GACOR</a>\n\n` +
                    `Semoga JP Paus di sini ya kak! ðŸ’°ðŸ’¸`;
                await tgSendText(chatId, welcomeText);
                console.log(`ðŸ‘‹ Sent Welcome to TG: ${name}`);
            }
        }
        return; // Selesai jika ini hanya update member baru
    }

    const from = message.from || {};
    const fromName = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Unknown';
    const username = from.username ? `@${from.username}` : '';
    const text = safeStr(message.text || message.caption || '');

    // ===== AUTO-SAVE TG CONTACT =====
    if (chatType === 'private' && String(chatId) !== String(ADMIN_GROUP_ID) && String(chatId) !== String(LOG_GROUP_ID)) {
        if (!tgContacts[chatId]) {
            tgContacts[chatId] = { name: fromName, username, firstSeen: nowISO() };
        }
        tgContacts[chatId].lastSeen = nowISO();
        tgContacts[chatId].name = fromName;
        tgContacts[chatId].username = username;
        saveJSON(TG_CONTACTS_FILE, tgContacts);
    }

    // Ekstrak perintah jika ada
    let cmd = '';
    let args = '';
    if (text.startsWith('/')) {
        const parts = text.split(' ');
        cmd = parts[0].toLowerCase();
        args = parts.slice(1).join(' ');
        if (cmd.includes('@')) cmd = cmd.split('@')[0];
    }

    // ===== GLOBAL COMMANDS (Anywhere) =====
    if (cmd === '/id') {
        return tgSendText(chatId, `ðŸ†” <b>Informasi Chat</b>\n\nChat ID: <code>${chatId}</code>\nType: <b>${chatType}</b>\n\nADMIN_GROUP_ID di server: <code>${process.env.ADMIN_GROUP_ID}</code>`);
    }

    if (cmd === '/debug') {
        const maskedToken = TELEGRAM_BOT_TOKEN ? `${TELEGRAM_BOT_TOKEN.substring(0, 5)}...${TELEGRAM_BOT_TOKEN.substring(TELEGRAM_BOT_TOKEN.length - 5)}` : 'MISSING';
        return tgSendText(chatId,
            `ðŸ› ï¸ <b>Debug Info:</b>\n\n` +
            `Token: <code>${maskedToken}</code>\n` +
            `Admin ID: <code>${ADMIN_GROUP_ID}</code>\n` +
            `Log ID: <code>${LOG_GROUP_ID}</code>\n` +
            `Render URL: <code>${process.env.RENDER_URL || 'NOT SET'}</code>\n` +
            `Port: <code>${PORT}</code>`
        );
    }

    // 1) Admin Commands (Broadcast, Templates, dll)
    const IS_ADMIN = String(chatId).trim() === String(ADMIN_GROUP_ID).trim() || String(chatId).trim() === String(LOG_GROUP_ID).trim();

    if (cmd && IS_ADMIN) {
        if (cmd === '/ping') {
            return tgSendText(chatId, `ðŸ“ <b>PONG!</b> Melody aktif kak!\n\nSesi WA: ${waActiveSessions}\nKontak TG: ${Object.keys(tgContacts).length}`);
        }

        if (cmd === '/broadcast') {
            if (!args) return tgSendText(chatId, 'Usage: /broadcast [text]');
            await tgSendText(chatId, 'â³ Starting broadcast to all contacts...');
            const r = await callWABridgeAPI('/broadcast', { text: args }, 'POST');
            if (!r.ok) return tgSendText(chatId, `âŒ Failed: ${r.error}`);
            return;
        }

        if (cmd === '/broadcast_tg') {
            if (!args) return tgSendText(chatId, 'Usage: /broadcast_tg [text]');

            const tgJids = Object.keys(tgContacts);
            if (tgJids.length === 0) return tgSendText(chatId, 'âŒ Belum ada pengguna Telegram yang tersimpan di database.');

            await tgSendText(chatId, `â³ Starting broadcast to ${tgJids.length} Telegram users...`);

            // Run async to not block
            (async () => {
                let sent = 0;
                let failed = 0;
                for (const jid of tgJids) {
                    const r = await tgSendText(jid, args);
                    if (r) sent++; else failed++;

                    // Anti-ban delay: 1.5 to 3 seconds
                    await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 1500));
                }

                await tgSendText(chatId, `ðŸ“¢ <b>TG BROADCAST COMPLETE</b>\nâœ… Sent: ${sent}\nâŒ Failed: ${failed}\nðŸ“Š Total: ${tgJids.length}`);
            })();
            return;
        }

        if (cmd === '/broadcast_wa') {
            const parts = text.split(' ');
            const jids = parts[1];
            const msg = parts.slice(2).join(' ');
            if (!jids || !msg) return tgSendText(chatId, 'Usage: /broadcast_wa [jid1,jid2] [text]');
            await tgSendText(chatId, `â³ Starting targeted broadcast...`);
            const r = await callWABridgeAPI('/broadcast', { text: msg, targets: jids.split(',') }, 'POST');
            if (!r.ok) return tgSendText(chatId, `âŒ Failed: ${r.error}`);
            return;
        }

        if (cmd === '/broadcast_loc') {
            const parts = text.split(' ');
            const latlon = parts[1];
            const radius = parseFloat(parts[2]);
            const msg = parts.slice(3).join(' ');

            if (!latlon || isNaN(radius) || !msg) {
                return tgSendText(chatId, 'Usage: /broadcast_loc [lat],[lon] [radius_km] [text]\nExample: /broadcast_loc -6.2,106.8 10 Promo khusus warga Jakarta!');
            }

            const [latStr, lonStr] = latlon.split(',');
            const lat = parseFloat(latStr);
            const lon = parseFloat(lonStr);

            if (isNaN(lat) || isNaN(lon)) return tgSendText(chatId, 'âŒ Format lokasi salah. Gunakan titik (.), contoh: -6.2,106.8');

            await tgSendText(chatId, `â³ Starting location-based broadcast (Radius: ${radius}km)...`);
            const r = await callWABridgeAPI('/broadcast', { text: msg, lat, lon, radius }, 'POST');
            if (!r.ok) return tgSendText(chatId, `âŒ Failed: ${r.error}`);
            return;
        }

        if (cmd === '/set_lokasi') {
            const parts = text.split(' ');
            const jid = parts[1];
            const latlon = parts[2];

            if (!jid || !latlon) {
                return tgSendText(chatId, 'Usage: /set_lokasi [nomor_WA] [lat],[lon]\nExample: /set_lokasi 6281234567 -6.2,106.8');
            }

            const [latStr, lonStr] = latlon.split(',');
            const lat = parseFloat(latStr);
            const lon = parseFloat(lonStr);

            if (isNaN(lat) || isNaN(lon)) return tgSendText(chatId, 'âŒ Format lokasi salah. Gunakan titik (.), contoh: -6.2,106.8');

            const r = await callWABridgeAPI('/contact/loc', { jid, lat, lon }, 'POST');
            return tgSendText(chatId, r.ok ? `âœ… ${r.message}` : `âŒ Failed: ${r.error}`);
        }

        if (cmd === '/export_data') {
            await tgSendText(chatId, 'â³ Meng-export data kontak WA & Telegram...');

            const r = await callWABridgeAPI('/contacts', {}, 'GET');
            const waContacts = r.contacts || [];

            let csv = 'Platform,JID/ChatID,Name,Username,LastSeen,FirstSeen,Lat,Lon\n';

            waContacts.forEach(c => {
                csv += `WhatsApp,${c.jid},"${c.name}","",${c.lastSeen},${c.firstSeen},${c.lat || ''},${c.lon || ''}\n`;
            });

            Object.entries(tgContacts).forEach(([id, c]) => {
                csv += `Telegram,${id},"${c.name}","${c.username || ''}",${c.lastSeen || ''},${c.firstSeen || ''},,\n`;
            });

            const buffer = Buffer.from(csv, 'utf-8');
            const d = new Date();
            const dateStr = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

            await tgSendDocument(chatId, buffer, `Export_Kontak_${dateStr}.csv`, 'âœ… Ini data kontak WhatsApp dan Telegram kamu (bisa dibuka di Excel).');
            return;
        }

        if (cmd === '/template_add') {
            const parts = text.split(' ');
            const name = parts[1];
            const msg = parts.slice(2).join(' ');
            if (!name || !msg) return tgSendText(chatId, 'Usage: /template_add [name] [text]');
            const r = await callWABridgeAPI('/template', { action: 'add', name, text: msg }, 'POST');
            return tgSendText(chatId, r.ok ? `âœ… ${r.message}` : `âŒ Failed: ${r.error}`);
        }

        if (cmd === '/template_list') {
            const r = await callWABridgeAPI('/template', { action: 'list' }, 'POST');
            if (!r.ok) return tgSendText(chatId, `âŒ Failed: ${r.error}`);
            const list = (r.templates || []).map(t => `- <b>${t.name}</b>: ${t.text.substring(0, 30)}...`).join('\n');
            return tgSendText(chatId, list ? `ðŸ“‹ <b>Templates:</b>\n${list}` : 'No templates.');
        }

        if (cmd === '/template_del') {
            const parts = text.split(' ');
            const name = parts[1];
            if (!name) return tgSendText(chatId, 'Usage: /template_del [name]');
            const r = await callWABridgeAPI('/template', { action: 'del', name }, 'POST');
            return tgSendText(chatId, r.ok ? `âœ… ${r.message}` : `âŒ Failed: ${r.error}`);
        }

        if (cmd === '/schedule_add') {
            const parts = text.split(' ');
            const time = parts[1];
            const name = parts[2];
            if (!time || !name) return tgSendText(chatId, 'Usage: /schedule_add [HH:MM] [templateName]\nExample: /schedule_add 09:00 promo1');
            const r = await callWABridgeAPI('/schedule', { action: 'add', time, templateName: name }, 'POST');
            return tgSendText(chatId, r.ok ? `âœ… ${r.message}` : `âŒ Failed: ${r.error}`);
        }

        if (cmd === '/schedule_list') {
            const r = await callWABridgeAPI('/schedule', { action: 'list' }, 'POST');
            if (!r.ok) return tgSendText(chatId, `âŒ Failed: ${r.error}`);
            const list = (r.schedules || []).map(s => `- [<code>${s.id}</code>] ${s.time} -> ${s.templateName} (${s.enabled ? 'ON' : 'OFF'})`).join('\n');
            return tgSendText(chatId, list ? `â° <b>Schedules:</b>\n${list}` : 'No schedules.');
        }

        if (cmd === '/schedule_del') {
            const parts = text.split(' ');
            const id = parts[1];
            if (!id) return tgSendText(chatId, 'Usage: /schedule_del [id]');
            const r = await callWABridgeAPI('/schedule', { action: 'del', id }, 'POST');
            return tgSendText(chatId, r.ok ? `âœ… ${r.message}` : `âŒ Failed: ${r.error}`);
        }

        if (cmd === '/schedule_toggle') {
            const parts = text.split(' ');
            const id = parts[1];
            if (!id) return tgSendText(chatId, 'Usage: /schedule_toggle [id]');
            const r = await callWABridgeAPI('/schedule', { action: 'toggle', id }, 'POST');
            return tgSendText(chatId, r.ok ? `âœ… Schedule ${id} is now ${r.enabled ? 'ON' : 'OFF'}` : `âŒ Failed: ${r.error}`);
        }

        if (cmd === '/contacts_count') {
            const r = await callWABridgeAPI('/contacts', {}, 'GET');
            return tgSendText(chatId, r.ok ? `ðŸ“Š Total WhatsApp contacts saved: ${r.count}` : `âŒ Failed: ${r.error}`);
        }

        if (cmd === '/help') {
            return tgSendText(chatId,
                `ðŸ¤– <b>Admin Commands:</b>\n\n` +
                `<b>Broadcast:</b>\n` +
                `/broadcast [text] (All WA)\n` +
                `/broadcast_tg [text] (All TG)\n` +
                `/broadcast_wa [jids] [text]\n` +
                `/broadcast_loc [lat],[lon] [radius_km] [text]\n` +
                `/broadcast_media [caption] (Balas ke gambar)\n\n` +
                `<b>Kontak & Lokasi:</b>\n` +
                `/set_lokasi [nomor_WA] [lat],[lon]\n` +
                `/contacts_count\n` +
                `/export_data\n\n` +
                `<b>Templates:</b>\n` +
                `/template_add [name] [text]\n` +
                `/template_list\n` +
                `/template_del [name]\n\n` +
                `<b>Schedules:</b>\n` +
                `/schedule_add [HH:MM] [template]\n` +
                `/schedule_list\n` +
                `/schedule_del [id]\n` +
                `/schedule_toggle [id]\n\n` +
                `<b>Config:</b>\n` +
                `/set_bridge [url]\n\n` +
                `<b>Info:</b>\n` +
                `/ping | /id | /debug`
            );
        }

        if (cmd === '/done') {
            if (!args) return tgSendText(chatId, 'Usage: /done [WA_JID atau TG_CHAT_ID]\nContoh: /done 102113451466939@lid');
            const targetId = args.trim();
            if (humanTakeovers[targetId]) {
                delete humanTakeovers[targetId];
                await tgSendText(chatId, `âœ… Human takeover untuk <code>${targetId}</code> selesai. AI Melody aktif kembali untuk member ini.`);
                // Notify member
                if (targetId.includes('@')) {
                    await callWABridgeSend({ jid: targetId, text: 'âœ… Terima kasih kak! Admin sudah selesai membantu. Melody kembali siap melayani kakak. ðŸ˜Š' });
                } else {
                    await tgSendText(targetId, 'âœ… Terima kasih kak! Admin sudah selesai membantu. Melody kembali siap melayani kakak. ðŸ˜Š');
                }
            } else {
                await tgSendText(chatId, `âš ï¸ Tidak ada takeover aktif untuk <code>${targetId}</code>`);
            }
            return;
        }

        if (cmd === '/set_bridge') {
            if (!args) return tgSendText(chatId, 'âŒ Sertakan URL bridge. Contoh: <code>/set_bridge https://abc.ngrok-free.app</code>');
            WA_BRIDGE_URL = args.trim();
            return tgSendText(chatId, `âœ… <b>WA_BRIDGE_URL diperbarui:</b>\n<code>${WA_BRIDGE_URL}</code>\n\n<i>Perubahan ini bersifat sementara sampai server restart/deploy ulang. Untuk permanen, update di Render Dashboard.</i>`);
        }

        // Unknown Command Catch for Admin
        if (cmd.startsWith('/')) {
            return tgSendText(chatId, `â“ Perintah <b>${cmd}</b> tidak dikenal. Ketik /help untuk daftar perintah.`);
        }
    }

    // 1.2) Admin group reply routing (Takeover / Manual Reply)
    if (IS_ADMIN && message.reply_to_message) {
        const replyTo = message.reply_to_message;
        const originalText = replyTo.text || replyTo.caption || '';
        const meta = extractMetaFromText(originalText);

        let targetId = meta.WA_JID || meta.TG_CHAT_ID;

        if (targetId) {
            // Kirim balik ke member
            if (targetId.includes('@')) { // WA
                await callWABridgeSend({ jid: targetId, text: text });
            } else { // TG
                await tgSendText(targetId, text);
            }
            console.log(`ðŸ’¬ Admin ${fromName} replied to ${targetId}: ${text}`);
            return;
        }

        if (cmd === '/broadcast_media') {
            const replyMsg = message.reply_to_message;
            const mediaObj = await extractTelegramNonTextMedia(replyMsg);

            if (mediaObj.type === 'Unknown' || !mediaObj.buffer) {
                await tgSendText(chatId, 'âŒ Pesan yang kamu reply bukan berupa Foto/Dokumen/Video yang valid.');
                return;
            }

            const mediaBase64 = mediaObj.buffer.toString('base64');
            const mediaType = mediaObj.sendType; // 'photo' or 'document'
            const mediaFilename = mediaObj.filename;

            await tgSendText(chatId, `â³ Starting Media Broadcast to all WA contacts...`);
            const r = await callWABridgeAPI('/broadcast', { text: args, mediaBase64, mediaType, mediaFilename }, 'POST');
            if (!r.ok) await tgSendText(chatId, `âŒ Failed: ${r.error}`);
            return;
        }

        // kalau admin reply tapi targetId tidak ketemu
        await tgSendText(ADMIN_GROUP_ID, 'âš ï¸ Reply ini tidak punya meta WA_JID/TG_CHAT_ID. Pastikan reply pesan tiket yang ada metadata.');
        return;
    }

    // 1.3) Admin sends message without reply â€” show hint
    if (IS_ADMIN && !message.reply_to_message && !cmd && text) {
        await tgSendText(chatId, `ðŸ’¡ <b>Tip:</b> Untuk membalas member, <b>reply (geser kanan)</b> pesan tiket yang ada metadata WA_JID/TG_CHAT_ID.\n\nKetik /help untuk daftar perintah.`);
        return;
    }

    // 1.5) Player Group Logic (Telegram Group)
    if (chatType === 'group' || chatType === 'supergroup') {
        // ... (sisanya tetap)
        // Handle Commands
        if (cmd === '/setgrup' || cmd === '/setgroup') {
            tgConfig.playerGroupId = chatId;
            saveJSON(TG_CONFIG_FILE, tgConfig);
            await tgSendText(chatId, 'âœ… <b>Melody Aktif!</b> Grup Telegram ini sekarang terdaftar sebagai Grup Player ICE3BET. Melody akan menjaga grup ini tetap seru!');
            return;
        }

        if (cmd === '/gacor' || cmd === '/testgacor') {
            const games = [
                { name: 'Gates of Olympus (Zeus)', rtp: '98%', pattern: '10x Manual, 30x Quick, 50x Turbo' },
                { name: 'Starlight Princess', rtp: '97%', pattern: '20x Auto, 50x Turbo, On/Off DC' },
                { name: 'Mahjong Ways 2', rtp: '96%', pattern: '10x Manual, 70x Turbo' },
                { name: 'Sugar Rush', rtp: '95%', pattern: '30x Auto, 30x Quick' }
            ];
            const selected = games[Math.floor(Math.random() * games.length)];
            const gacorText = `ðŸŽ° <b>INFO BOCORAN GACOR ICE3BET</b> ðŸŽ°\n\n` +
                `ðŸ”¥ Game: <b>${selected.name}</b>\n` +
                `ðŸ“ˆ RTP: <b>${selected.rtp}</b>\n` +
                `ðŸ› ï¸ Pola: <code>${selected.pattern}</code>\n\n` +
                `ðŸš€ Gas sekarang di: <a href="https://cutt.ly/ice3bet-alternatif2">KLIK LOGIN</a>\n` +
                `Semoga JP Paus hari ini ya kak! ðŸ™ðŸ’°`;
            await tgSendText(chatId, gacorText);
            return;
        }

        if (cmd === '/cekoki') {
            const khodams = ['Kakek Zeus âš¡', 'Inces Starlight âœ¨', 'Panda Mahjong ðŸ¼', 'Permen Sugar Rush ðŸ¬', 'Kucing Lucky Neko ðŸ±'];
            const khodam = khodams[Math.floor(Math.random() * khodams.length)];
            await tgSendText(chatId, `ðŸ”® <b>RAMALAN GACOR Melody</b> ðŸ”®\n\nHari ini Kakak dijaga oleh Khodam: <b>${khodam}</b>\n\nMelody ramalkan kakak bakal JP Paus kalau main di provider Pragmatic jam sekarang! Gas tipis-tipis kak! ðŸš€ðŸŽ°`);
            return;
        }

        // --- ADMIN ASSISTANT (Trigger di semua chat grup) ---
        if (text.toLowerCase().includes('admin') || text.toLowerCase().includes('@admin')) {
            await tgSendText(chatId, `Halo Kak! Ada yang bisa Melody bantu? Admin sedang sibuk memproses antrian depo/wd nih. ðŸ™‡â€â™€ï¸\n\nSambil nunggu, bisa cek info /gacor dulu ya kak! âœ¨`);
        }

        // --- ANTI-SPAM LINK (Trigger di semua chat grup) ---
        if (!IS_ADMIN && !cmd && (text.toLowerCase().includes('http') || text.toLowerCase().includes('.com') || text.toLowerCase().includes('.net'))) {
            if (!text.toLowerCase().includes('ICE3BET') && !text.toLowerCase().includes('cutt.ly')) {
                // Karena Melody bukan admin, kita hanya beri teguran keras
                await tgSendText(chatId, `âš ï¸ <b>PERINGATAN Melody</b> âš ï¸\n\nHalo Kak @${from.username || from.first_name}, dilarang sebar link selain ICE3BET di sini ya! (ChatID: ${chatId}) ðŸ¤«ðŸ‘Š`);
            }
        }

        return; // Selesai untuk grup
    }

    // 2) Handle private user chat text
    if (message.text && chatType === 'private' && String(chatId) !== String(ADMIN_GROUP_ID) && String(chatId) !== String(LOG_GROUP_ID)) {

        const isHuman = humanTakeovers[chatId];
        if (isHuman) {
            // --- MODE MANUSIA (AI OFF) ---
            await sendToAdminTicket(`${fromName} ${username}`.trim(), {
                target: 'TG',
                metaLines: [`TG_CHAT_ID: ${chatId}`, `From: ${fromName}`, `Type: TEXT`, `Mode: HUMAN`],
                contentLines: [`ðŸ’¬ <b>Member:</b> ${message.text}`]
            });
            return;
        }

        // --- MODE AI (GEMINI) ---
        let aiReply = await getGeminiResponse(message.text, chatId.toString(), fromName);

        // Handover check (AI menyerah)
        const aiSurrender = aiReply.includes('[TIKET]');
        if (aiSurrender) aiReply = aiReply.replace('[TIKET]', '').trim();

        // Kirim balasan AI ke member
        await tgSendText(chatId, aiReply);

        // Lapor Admin
        await sendToAdminTicket(`${fromName} ${username}`.trim(), {
            target: 'TG',
            metaLines: [`TG_CHAT_ID: ${chatId}`, `From: ${fromName}`, `Type: TEXT`, `Mode: AI`],
            contentLines: [
                `ðŸ’¬ <b>Member:</b> ${message.text}`,
                `ðŸ¤– <b>Melody:</b> ${aiReply}`
            ]
        });
        return;
    }

    // 3) Voice note -> STT -> trigger
    if (message.voice) {
        const fileLink = await tgGetFileLink(message.voice.file_id);
        if (!fileLink) {
            await tgSendText(chatId, 'âŒ Gagal baca voice. Coba ulang ya kak.');
            return;
        }

        // download ogg
        const ogg = await axios.get(fileLink, { responseType: 'arraybuffer', timeout: 30000 })
            .then(r => Buffer.from(r.data))
            .catch(() => null);

        if (!ogg) {
            await tgSendText(chatId, 'âŒ Gagal download voice. Coba ulang ya kak.');
            return;
        }

        const transcribed = await elevenSTTFromOgg(ogg);

        if (!transcribed) {
            // fallback tiket
            await sendToAdminTicket(`${fromName} ${username}`.trim(), {
                target: 'TG',
                metaLines: [
                    `TG_CHAT_ID: ${chatId}`,
                    `From: ${fromName} ${username}`.trim(),
                    `UserID: ${from.id}`,
                    `ChatType: ${chatType}`
                ],
                contentLines: ['Voice: (STT gagal / tidak aktif)'],
                media: { type: 'document', buffer: ogg, filename: 'voice.ogg' }
            });

            await tgSendText(chatId, 'âš ï¸ Voice note diterima, tapi STT belum bisa dibaca. Admin akan bantu ya kak ðŸ™');
            return;
        }

        const hit = matchTrigger(transcribed);

        if (hit) {
            await tgSendText(chatId, hit.reply);

            // TTS (kecuali LINK)
            if (hit.category !== 'LINK') {
                const voice = await elevenTTS(hit.reply);
                if (voice) await tgSendVoice(chatId, voice, 'reply.ogg');
            }

            await logToGroup('ðŸŽ™ï¸ TG VOICE TRIGGER', [
                `Time: ${nowISO()}`,
                `Category: ${hit.category}`,
                `From: ${fromName} ${username}`.trim(),
                `UserID: ${from.id}`,
                `ChatID: ${chatId}`,
                `STT: ${transcribed}`
            ]);
            return;
        }

        // --- OTAK AI GEMINI UNTUK VOICE TG ---
        let aiReply = await getGeminiResponse(transcribed, chatId.toString(), fromName);

        // Handover check
        if (aiReply.includes('[TIKET]')) {
            aiReply = aiReply.replace('[TIKET]', '').trim();
            await sendToAdminTicket(`${fromName} ${username}`.trim(), {
                target: 'TG',
                metaLines: [`TG_CHAT_ID: ${chatId}`, `From: ${fromName} ${username}`.trim(), `Type: VOICE_HANDOVER`],
                contentLines: [`Transcript: ${transcribed}`],
                media: { type: 'document', buffer: ogg, filename: 'voice.ogg' }
            });
        }

        await tgSendText(chatId, aiReply);
        return;
    }

    // 4) Semua tipe non-text (photo, doc, sticker, location, etc) -> tiket ke admin + forward file
    const media = await extractTelegramNonTextMedia(message);
    await sendToAdminTicket(`${fromName} ${username}`.trim(), {
        target: 'TG',
        metaLines: [
            `TG_CHAT_ID: ${chatId}`,
            `From: ${fromName} ${username}`.trim(),
            `UserID: ${from.id}`,
            `ChatType: ${chatType}`
        ],
        contentLines: [
            `Type: ${media.type}`,
            media.extra ? media.extra : ''
        ].filter(Boolean),
        media: media.buffer ? { type: media.sendType, buffer: media.buffer, filename: media.filename } : null
    });

    await tgSendText(chatId, 'âœ… Pesan kamu sudah masuk ke admin ya kak. Admin akan bantu ðŸ™');
}

async function extractTelegramNonTextMedia(message) {
    // returns {type, buffer?, filename?, sendType:'photo'|'document', extra?}
    try {
        if (message.photo && message.photo.length) {
            const best = message.photo[message.photo.length - 1];
            const link = await tgGetFileLink(best.file_id);
            const buf = link ? await axios.get(link, { responseType: 'arraybuffer', timeout: 30000 }).then(r => Buffer.from(r.data)) : null;
            return { type: 'Photo', buffer: buf, filename: 'photo.jpg', sendType: 'photo' };
        }

        if (message.document) {
            const link = await tgGetFileLink(message.document.file_id);
            const buf = link ? await axios.get(link, { responseType: 'arraybuffer', timeout: 45000 }).then(r => Buffer.from(r.data)) : null;
            return { type: 'Document', buffer: buf, filename: message.document.file_name || 'document.bin', sendType: 'document' };
        }

        if (message.sticker) {
            const link = await tgGetFileLink(message.sticker.file_id);
            const buf = link ? await axios.get(link, { responseType: 'arraybuffer', timeout: 30000 }).then(r => Buffer.from(r.data)) : null;
            return { type: 'Sticker', buffer: buf, filename: 'sticker.webp', sendType: 'document' };
        }

        if (message.video) {
            const link = await tgGetFileLink(message.video.file_id);
            const buf = link ? await axios.get(link, { responseType: 'arraybuffer', timeout: 45000 }).then(r => Buffer.from(r.data)) : null;
            return { type: 'Video', buffer: buf, filename: 'video.mp4', sendType: 'document' };
        }

        if (message.audio) {
            const link = await tgGetFileLink(message.audio.file_id);
            const buf = link ? await axios.get(link, { responseType: 'arraybuffer', timeout: 45000 }).then(r => Buffer.from(r.data)) : null;
            return { type: 'Audio', buffer: buf, filename: 'audio.mp3', sendType: 'document' };
        }

        if (message.location) {
            return {
                type: 'Location',
                extra: `Lat: ${message.location.latitude}, Lon: ${message.location.longitude}`
            };
        }

        if (message.contact) {
            return {
                type: 'Contact',
                extra: `Name: ${safeStr(message.contact.first_name)} ${safeStr(message.contact.last_name)} | Phone: ${safeStr(message.contact.phone_number)}`
            };
        }

        return { type: 'Unknown' };
    } catch (err) {
        console.error('âŒ extractTelegramNonTextMedia error:', err.message);
        return { type: 'Unknown' };
    }
}

// ===================== DASHBOARD ENDPOINTS =====================
app.get('/dashboard', (req, res) => {
    res.send(DASHBOARD_HTML);
});

app.get('/api/stats', (req, res) => {
    const pw = req.query.pw;
    if (pw !== DASHBOARD_PASSWORD) return res.status(401).json({ ok: false });

    res.json({
        ok: true,
        waContacts: waContactsSync,
        tgCount: Object.keys(tgContacts).length,
        activeSessions: waActiveSessions,
        lastSync: lastSyncTime
    });
});

app.post('/wa/sync', (req, res) => {
    const secret = req.headers['x-bridge-secret'];
    if (WA_BRIDGE_SECRET && secret !== WA_BRIDGE_SECRET) return res.status(401).end();

    waContactsSync = req.body.contacts || {};
    waActiveSessions = req.body.activeSessions || 0;
    lastSyncTime = new Date().toLocaleTimeString();
    res.json({ ok: true });
});

// ===================== AUTO-REGISTER BRIDGE URL =====================
app.post('/wa/register-bridge', (req, res) => {
    const secret = req.headers['x-bridge-secret'];
    if (WA_BRIDGE_SECRET && secret !== WA_BRIDGE_SECRET) return res.status(401).end();

    const newUrl = req.body.bridgeUrl;
    if (!newUrl) return res.status(400).json({ ok: false, error: 'missing bridgeUrl' });

    const oldUrl = WA_BRIDGE_URL;
    WA_BRIDGE_URL = newUrl.replace(/\/$/, '');

    if (oldUrl !== WA_BRIDGE_URL) {
        console.log(`ðŸ”„ WA_BRIDGE_URL updated: ${oldUrl || 'EMPTY'} â†’ ${WA_BRIDGE_URL}`);
    }

    res.json({ ok: true, bridgeUrl: WA_BRIDGE_URL });
});

// ===================== WA -> TG INCOMING (from PC bridge) =====================
app.post('/wa/incoming', upload.any(), async (req, res) => {
    const { jid, pushName, text, type } = req.body;
    
    console.log(`ðŸ“¥ Incoming WA: ${pushName} (${jid}) - ${text}`);
    console.log(`ðŸ“¡ Current WA_BRIDGE_URL used for AI reply: ${WA_BRIDGE_URL || 'NOT SET'}`);
    
    try {
        const secret = req.headers['x-bridge-secret'];
        if (WA_BRIDGE_SECRET && secret !== WA_BRIDGE_SECRET) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }

        res.json({ ok: true });

        const body = req.body || {};
        const files = req.files || [];

        const waJid = safeStr(body.jid);
        const pushName = safeStr(body.pushName);
        const text = safeStr(body.text);
        const type = safeStr(body.type); // TEXT/IMAGE/VIDEO/DOC/STICKER/LOCATION

        // ðŸŽ™ï¸ Melody VOICE RESPONSE (Hanya untuk VN di Private Chat)
        if (type === 'AUDIO' && !waJid.includes('@g.us')) {
            try {
                const audioFile = files.find(f => f.fieldname === 'media');
                if (audioFile) {
                    console.log('ðŸŽ™ï¸ Melody Processing Voice Note...');
                    const sttText = await elevenSTTFromOgg(audioFile.buffer);
                    if (sttText) {
                        let aiReply = await getGeminiResponse(sttText, jid, pushName);

                        // Handover check
                        if (aiReply.includes('[TIKET]')) {
                            aiReply = aiReply.replace('[TIKET]', '').trim();
                            await sendToAdminTicket(pushName, {
                                target: 'WA',
                                metaLines: [`WA_JID: ${waJid}`, `From: ${pushName}`, `Type: AUDIO_HANDOVER`],
                                contentLines: [`Transcript: ${sttText}`]
                            });
                        }

                        const voiceBuf = await elevenTTS(aiReply);
                        if (voiceBuf) {
                            await callWABridgeAPI('/send', {
                                jid: waJid,
                                audioBase64: voiceBuf.toString('base64')
                            }, 'POST');
                        }
                    }
                }
            } catch (e) {
                console.log('âŒ Melody Voice Error:', e.message);
            }
        }

        const hit = matchTrigger(text);

        await logToGroup('ðŸ“© WA INCOMING', [
            `Time: ${nowISO()}`,
            `WA_JID: ${waJid}`,
            `From: ${pushName}`,
            `Type: ${type}`,
            `Text: ${text || '(no text)'}`
        ]);

        const isHuman = humanTakeovers[waJid];

        if (isHuman) {
            // --- MODE MANUSIA (AI OFF) ---
            await sendToAdminTicket(pushName, {
                target: 'WA',
                metaLines: [`WA_JID: ${waJid}`, `From: ${pushName}`, `Type: ${type}`, `Mode: HUMAN`],
                contentLines: text ? [`ðŸ’¬ <b>Member:</b> ${text}`] : [`ðŸ“Ž <b>Type:</b> ${type}`],
                media: files[0] ? { type: (type === 'IMAGE' ? 'photo' : 'document'), buffer: files[0].buffer, filename: files[0].originalname } : null
            });
            return;
        }

        // --- MODE AI (GEMINI) ---
        if (type === 'TEXT' && !waJid.includes('@g.us')) {
            let aiReply = await getGeminiResponse(text, jid, pushName);

            // Handover check (AI menyerah)
            const aiSurrender = aiReply.includes('[TIKET]');
            if (aiSurrender) aiReply = aiReply.replace('[TIKET]', '').trim();

            // Kirim balasan AI ke member
            const bridgeRes = await callWABridgeSend({ jid: waJid, text: aiReply });
        if (!bridgeRes.ok) {
            await tgSendText(ADMIN_GROUP_ID, `âš ï¸ <b>GAGAL KIRIM KE WA</b>\nMember: ${pushName}\nError: <code>${bridgeRes.error}</code>\nURL: <code>${WA_BRIDGE_URL}</code>`);
        }

            // Lapor ke Admin
            await sendToAdminTicket(pushName, {
                target: 'WA',
                metaLines: [`WA_JID: ${waJid}`, `From: ${pushName}`, `Type: TEXT`, `Mode: AI`],
                contentLines: [
                    `ðŸ’¬ <b>Member:</b> ${text}`,
                    `ðŸ¤– <b>Melody:</b> ${aiReply}`
                ]
            });
            return;
        }

        // buat tiket ke admin
        const media = files[0] ? { buffer: files[0].buffer, filename: files[0].originalname || 'wa-file.bin' } : null;

        await sendToAdminTicket(pushName, {
            target: 'WA',
            metaLines: [
                `WA_JID: ${waJid}`,
                `From: ${pushName}`,
                `Type: ${type}`
            ],
            contentLines: text ? [`Text: ${text}`] : [`Type: ${type}`],
            media: media ? { type: (type === 'IMAGE' ? 'photo' : 'document'), buffer: media.buffer, filename: media.filename } : null
        });

        // optional: kasih auto-reply kalau bukan trigger
        // (biar user tahu sedang diproses)
        // reply WA dilakukan lewat bridge, bukan dari sini.

    } catch (e) {
        console.error('âŒ /wa/incoming error', e);
        // Response sudah dikirim di atas, jadi cukup log saja
    }
});

// ===================== START =====================
// Interval Gacor Telegram
async function sendGacorUpdate() {
    if (!tgConfig.playerGroupId) return;

    const games = [
        { name: 'Gates of Olympus (Zeus)', rtp: '98%', pattern: '10x Manual, 30x Quick, 50x Turbo' },
        { name: 'Starlight Princess', rtp: '97%', pattern: '20x Auto, 50x Turbo, On/Off DC' },
        { name: 'Mahjong Ways 2', rtp: '96%', pattern: '10x Manual, 70x Turbo' },
        { name: 'Sugar Rush', rtp: '95%', pattern: '30x Auto, 30x Quick' }
    ];

    const selected = games[Math.floor(Math.random() * games.length)];
    const gacorText = `ðŸŽ° <b>INFO BOCORAN GACOR ICE3BET</b> ðŸŽ°\n\n` +
        `ðŸ”¥ Game: <b>${selected.name}</b>\n` +
        `ðŸ“ˆ RTP: <b>${selected.rtp}</b>\n` +
        `ðŸ› ï¸ Pola: <code>${selected.pattern}</code>\n\n` +
        `ðŸš€ Gas sekarang di: <a href="https://cutt.ly/ice3bet-alternatif2">KLIK LOGIN</a>\n` +
        `Semoga JP Paus hari ini ya kak! ðŸ™ðŸ’°`;

    const res = await tgSendText(tgConfig.playerGroupId, gacorText);
    if (res) {
        console.log(`ðŸ“¢ [${new Date().toLocaleTimeString()}] Sent Gacor Update to TG Group: ${tgConfig.playerGroupId}`);
    } else {
        console.log(`âŒ [${new Date().toLocaleTimeString()}] FAILED to send Gacor Update to TG Group: ${tgConfig.playerGroupId}`);
    }
}

// Kirim pertama kali saat start (opsional, tapi bagus untuk verifikasi)
setTimeout(sendGacorUpdate, 5000); // Tunggu 5 detik setelah start
setInterval(sendGacorUpdate, 3 * 60 * 60 * 1000);

app.listen(PORT, async () => {
    console.log(`âœ… Telegram Hub listening on ${PORT}`);
    console.log(`ðŸŒ Ready: /webhook`);

    // Automated Webhook Setup & Debug
    const setupWebhook = async () => {
        try {
            // 1. Check current info
            const info = await axios.get(`${TG_API}/getWebhookInfo`);
            console.log('ðŸ” Current Webhook Status:', JSON.stringify(info.data.result));

            // 2. Force update if RENDER_URL exists
            const currentUrl = process.env.RENDER_URL || 'https://ice3bot.onrender.com';
            const targetUrl = `${currentUrl.replace(/\/$/, '')}/webhook`;

            console.log(`ðŸš€ Force setting webhook to: ${targetUrl}`);
            const r = await axios.post(`${TG_API}/setWebhook`, {
                url: targetUrl,
                drop_pending_updates: true,
                allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member']
            });
            console.log('âœ… Telegram SetWebhook Response:', JSON.stringify(r.data));
        } catch (e) {
            console.log('âŒ Failed to setup webhook:', e.message);
            if (e.response) console.log('âŒ Error Data:', JSON.stringify(e.response.data));
        }
    };

    await setupWebhook();
});

