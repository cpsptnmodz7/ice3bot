'use strict';

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const pino = require('pino');

// ===================== ENV & CONST =====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID;
const LOG_GROUP_ID = process.env.LOG_GROUP_ID || ADMIN_GROUP_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const WA_PORT = Number(process.env.WA_PORT || 8787);
const BRIDGE_SECRET = process.env.WA_BRIDGE_SECRET || '';
const RENDER_URL = (process.env.RENDER_URL || '').replace(/\/$/, '');

if (!TELEGRAM_BOT_TOKEN || !ADMIN_GROUP_ID) {
    console.log('❌ Missing ENV: TELEGRAM_BOT_TOKEN, ADMIN_GROUP_ID');
    process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ===================== DATA PATHS =====================
const DATA_DIR = path.join(__dirname, 'data');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ===================== DATA HELPERS =====================
function loadJSON(filePath, defaultVal = {}) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
    } catch (e) {
        console.log(`⚠️ Failed to load ${filePath}:`, e.message);
    }
    return defaultVal;
}

function saveJSON(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.log(`⚠️ Failed to save ${filePath}:`, e.message);
    }
}

// ===================== CONTACTS STORE =====================
// { "628xxxx@s.whatsapp.net": { name: "John", lastSeen: "2026-...", messageCount: 5 } }
let contacts = loadJSON(CONTACTS_FILE, {});

function saveContact(jid, pushName, lat = null, lon = null) {
    if (!jid || jid.endsWith('@g.us')) return; // skip groups
    const existing = contacts[jid] || {};
    contacts[jid] = {
        name: pushName || existing.name || 'Unknown',
        lastSeen: new Date().toISOString(),
        messageCount: (existing.messageCount || 0) + 1,
        firstSeen: existing.firstSeen || new Date().toISOString(),
        points: (existing.points || 0) + 1, // Tambah poin loyalitas setiap chat
        lastActivity: Date.now(),
        lat: lat !== null ? lat : existing.lat,
        lon: lon !== null ? lon : existing.lon
    };
    saveJSON(CONTACTS_FILE, contacts);
}

// ===================== TEMPLATES STORE =====================
// { "promo1": { text: "Halo kak...", createdAt: "2026-..." } }
let templates = loadJSON(TEMPLATES_FILE, {});

function saveTemplates() {
    saveJSON(TEMPLATES_FILE, templates);
}

// ===================== SCHEDULES STORE =====================
let schedules = loadJSON(SCHEDULES_FILE, {});

function saveSchedules() {
    saveJSON(SCHEDULES_FILE, schedules);
}

// ===================== GLOBAL CONFIG =====================
let config = loadJSON(CONFIG_FILE, { playerGroupId: null });
function saveConfig() {
    saveJSON(CONFIG_FILE, config);
}

// ===================== UTILS =====================
function nowISO() {
    return new Date().toISOString();
}

function safeStr(v) {
    return (v === undefined || v === null) ? '' : String(v);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomSleep(minMs, maxMs) {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return sleep(ms);
}

// Haversine formula to calculate distance between two lat/lon in km
function getDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ===================== GEMINI AI (RECEIPT CHECKER) =====================
async function verifyReceiptAI(base64Image) {
    if (!GEMINI_API_KEY) return 'YES'; // Fallback aman

    try {
        console.log('🤖 Menganalisa gambar struk dengan Gemini AI...');
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const res = await axios.post(url, {
            contents: [{
                parts: [
                    { text: 'Apakah gambar ini terlihat seperti bukti transfer bank, mutasi rekening, atau bukti e-wallet (DANA, OVO, Gopay, dll) yang sah dan valid? Jawab HANYA dengan kata "YES" jika ya, dan "NO" jika tidak valid (misal gambar orang/hewan/pemandangan).' },
                    { inline_data: { mime_type: 'image/jpeg', data: base64Image } }
                ]
            }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 5
            }
        });

        const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (reply.toUpperCase().includes('YES')) return 'YES';
        if (reply.toUpperCase().includes('NO')) return 'NO';
        return 'UNKNOWN';
    } catch (e) {
        console.log('❌ Gemini AI Error:', e.response?.data?.error || e.message);
        return 'YES'; // Fallback aman jika API error
    }
}

// ===================== TRIGGERS =====================
function matchTrigger(rawText) {
    return null;
}

// ===================== TELEGRAM =====================
async function tgSendMessage(chatId, text) {
    try {
        const res = await axios.post(`${TG_API}/sendMessage`, {
            chat_id: chatId,
            text,
            parse_mode: 'HTML'
        });
        return res.data;
    } catch (e) {
        console.log('❌ tgSendMessage error', e.message);
        return null;
    }
}

// ===================== FORWARD TO RENDER =====================
async function forwardToRender(payload) {
    if (!RENDER_URL) {
        console.log('⚠️ RENDER_URL not set, skipping forward');
        return null;
    }

    try {
        const headers = {};
        if (BRIDGE_SECRET) headers['x-bridge-secret'] = BRIDGE_SECRET;

        if (payload.mediaBuffer) {
            const form = new FormData();
            form.append('jid', payload.jid || '');
            form.append('pushName', payload.pushName || '');
            form.append('text', payload.text || '');
            form.append('type', payload.type || 'TEXT');
            form.append('file', payload.mediaBuffer, {
                filename: payload.mediaFilename || 'file.bin'
            });

            const res = await axios.post(`${RENDER_URL}/wa/incoming`, form, {
                headers: { ...form.getHeaders(), ...headers },
                timeout: 20000
            });
            return res.data;
        }

        console.log(`📡 Forwarding to Render: ${payload.type} from ${payload.pushName}`);
        const res = await axios.post(`${RENDER_URL}/wa/incoming`, {
            jid: payload.jid || '',
            pushName: payload.pushName || '',
            text: payload.text || '',
            type: payload.type || 'TEXT'
        }, {
            headers,
            timeout: 20000
        });
        console.log('✅ Forwarded to Render success');
        return res.data;
    } catch (e) {
        console.log('❌ forwardToRender error:', e.response?.data || e.message);
        return null;
    }
}

// ===================== BROADCAST ENGINE (ANTI-BAN) =====================
const BROADCAST_DELAY_MIN = 3000;
const BROADCAST_DELAY_MAX = 8000;
const BATCH_SIZE = 20;
const BATCH_REST_MS = 60000; // 1 minute rest after every batch

async function executeBroadcast(text, jids, options = {}) {
    let sent = 0;
    let failed = 0;
    const errors = [];

    for (let i = 0; i < jids.length; i++) {
        const jid = jids[i];

        // Batch rest check
        if (i > 0 && i % BATCH_SIZE === 0) {
            console.log(`😴 Anti-ban resting for ${BATCH_REST_MS / 1000}s...`);
            await sleep(BATCH_REST_MS);
        }

        try {
            // Simulate typing
            await sock.sendPresenceUpdate('composing', jid);
            const typingTime = Math.min(Math.max(text.length * 50, 1000), 5000);
            await sleep(typingTime);

            // Send Media or Text
            if (options.mediaBase64) {
                const buffer = Buffer.from(options.mediaBase64, 'base64');
                const sendObj = options.mediaType === 'document'
                    ? { document: buffer, mimetype: 'application/pdf', fileName: options.mediaFilename || 'file', caption: text }
                    : { image: buffer, caption: text };
                await sock.sendMessage(jid, sendObj);
            } else {
                await sock.sendMessage(jid, { text });
            }

            // Send location if provided
            if (options.sendLat && options.sendLon) {
                await sleep(1000);
                await sock.sendMessage(jid, { location: { degreesLatitude: options.sendLat, degreesLongitude: options.sendLon } });
            }

            sent++;
            console.log(`📤 Broadcast sent: ${jid} (${sent}/${jids.length})`);
        } catch (e) {
            failed++;
            errors.push(`${jid}: ${e.message}`);
            console.log(`❌ Broadcast failed: ${jid} - ${e.message}`);
        }

        // Random delay between 3-8 seconds
        await randomSleep(BROADCAST_DELAY_MIN, BROADCAST_DELAY_MAX);
    }

    return { ok: true, sent, failed, total: jids.length, errors };
}

async function broadcastToAll(text, excludeJids = [], options = {}) {
    if (!sock) return { ok: false, error: 'WA not connected', sent: 0, failed: 0 };
    const jids = Object.keys(contacts).filter(j => !excludeJids.includes(j));
    if (jids.length === 0) return { ok: false, error: 'No contacts', sent: 0, failed: 0 };
    return executeBroadcast(text, jids, options);
}

async function broadcastToTargets(text, targetJids, options = {}) {
    if (!sock) return { ok: false, error: 'WA not connected', sent: 0, failed: 0 };
    if (!targetJids.length) return { ok: false, error: 'No targets', sent: 0, failed: 0 };

    const normalJids = targetJids.map(jid => jid.includes('@') ? jid : `${jid}@s.whatsapp.net`);
    return executeBroadcast(text, normalJids, options);
}

// ===================== SCHEDULE ENGINE =====================
function checkSchedules() {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    for (const [id, schedule] of Object.entries(schedules)) {
        if (!schedule.enabled) continue;
        if (schedule.time !== currentTime) continue;

        // Cek apakah sudah run hari ini
        const today = now.toISOString().split('T')[0];
        if (schedule.lastRun && schedule.lastRun.startsWith(today)) continue;

        // Jalankan broadcast
        const template = templates[schedule.templateName];
        if (!template) {
            console.log(`⚠️ Schedule ${id}: template "${schedule.templateName}" not found`);
            continue;
        }

        console.log(`⏰ Running scheduled broadcast: ${id} (${schedule.templateName})`);

        // Mark as run
        schedules[id].lastRun = nowISO();
        saveSchedules();

        // Execute broadcast (async, don't await)
        broadcastToAll(template.text).then(result => {
            tgSendMessage(LOG_GROUP_ID,
                `⏰ SCHEDULED BROADCAST\n` +
                `📋 Template: ${schedule.templateName}\n` +
                `🕐 Time: ${schedule.time}\n` +
                `✅ Sent: ${result.sent}\n` +
                `❌ Failed: ${result.failed}\n` +
                `📊 Total: ${result.total}`
            );
        });
    }
}

// Cek schedule setiap 60 detik
setInterval(checkSchedules, 60000);

// ===================== SERVER =====================
const app = express();
app.use(express.json());

let sock = null;

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        wa_connected: !!sock,
        contacts_count: Object.keys(contacts).length,
        templates_count: Object.keys(templates).length,
        schedules_count: Object.keys(schedules).length,
        timestamp: nowISO()
    });
});

// ===================== AUTH MIDDLEWARE =====================
function authCheck(req, res, next) {
    const secret = req.headers['x-bridge-secret'];
    if (BRIDGE_SECRET && secret !== BRIDGE_SECRET) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    next();
}

// ===================== SEND WA (dari Render) =====================
app.post('/send', authCheck, async (req, res) => {
    const jid = req.body?.jid;
    const text = req.body?.text;

    if (!jid || !text) {
        return res.status(400).json({ ok: false, error: 'missing jid or text' });
    }

    if (!sock) {
        return res.status(500).json({ ok: false, error: 'WA not connected' });
    }

    try {
        console.log(`📥 Received /send from Render for JID: ${jid}`);
        if (req.body.audioBase64) {
            const buffer = Buffer.from(req.body.audioBase64, 'base64');
            await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/ogg', ptt: true });
        } else {
            await sock.sendMessage(jid, { text });
        }
        console.log(`✅ Message sent to WhatsApp: ${jid}`);
        res.json({ ok: true });
    } catch (e) {
        console.log('❌ /send error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ===================== BROADCAST ENDPOINTS =====================
app.post('/broadcast', authCheck, async (req, res) => {
    const { text, targets, lat, lon, radius, sendLat, sendLon, mediaBase64, mediaType, mediaFilename } = req.body || {};

    if (!text && !mediaBase64) {
        return res.status(400).json({ ok: false, error: 'missing text or media' });
    }

    res.json({ ok: true, message: 'Broadcast started' });

    let result;
    const options = { sendLat, sendLon, mediaBase64, mediaType, mediaFilename };

    if (lat !== undefined && lon !== undefined && radius !== undefined) {
        // Location based broadcast
        const locationJids = [];
        for (const [jid, info] of Object.entries(contacts)) {
            if (info.lat && info.lon) {
                const dist = getDistance(lat, lon, info.lat, info.lon);
                if (dist <= radius) locationJids.push(jid);
            }
        }
        console.log(`📍 Location broadcast: ${locationJids.length} contacts found within ${radius}km`);
        result = await broadcastToTargets(text, locationJids, options);
    } else if (targets && Array.isArray(targets) && targets.length > 0) {
        result = await broadcastToTargets(text, targets, options);
    } else {
        result = await broadcastToAll(text, [], options);
    }

    await tgSendMessage(LOG_GROUP_ID,
        `📢 BROADCAST COMPLETE\n` +
        `✅ Sent: ${result.sent}\n` +
        `❌ Failed: ${result.failed}\n` +
        `📊 Total: ${result.total}`
    );
});

// ===================== CONTACTS ENDPOINTS =====================
app.get('/contacts', authCheck, (req, res) => {
    const list = Object.entries(contacts).map(([jid, info]) => ({
        jid,
        ...info
    }));
    res.json({ ok: true, count: list.length, contacts: list });
});

app.post('/contact/loc', authCheck, (req, res) => {
    const { jid, lat, lon } = req.body || {};
    if (!jid || lat === undefined || lon === undefined) {
        return res.status(400).json({ ok: false, error: 'missing jid, lat, or lon' });
    }

    const normalJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;

    const existing = contacts[normalJid] || {};
    contacts[normalJid] = {
        name: existing.name || 'Unknown',
        lastSeen: existing.lastSeen || new Date().toISOString(),
        messageCount: existing.messageCount || 0,
        firstSeen: existing.firstSeen || new Date().toISOString(),
        lat: parseFloat(lat),
        lon: parseFloat(lon)
    };
    saveJSON(CONTACTS_FILE, contacts);

    res.json({ ok: true, message: `Lokasi untuk ${normalJid} berhasil diset ke ${lat}, ${lon}` });
});

// ===================== TEMPLATE ENDPOINTS =====================
app.post('/template', authCheck, (req, res) => {
    const { action, name, text } = req.body || {};

    if (action === 'add') {
        if (!name || !text) {
            return res.status(400).json({ ok: false, error: 'missing name or text' });
        }
        templates[name] = { text, createdAt: nowISO(), updatedAt: nowISO() };
        saveTemplates();
        return res.json({ ok: true, message: `Template "${name}" saved` });
    }

    if (action === 'list') {
        const list = Object.entries(templates).map(([n, t]) => ({
            name: n,
            text: t.text,
            createdAt: t.createdAt
        }));
        return res.json({ ok: true, templates: list });
    }

    if (action === 'del') {
        if (!name) return res.status(400).json({ ok: false, error: 'missing name' });
        if (!templates[name]) return res.status(404).json({ ok: false, error: 'template not found' });
        delete templates[name];
        saveTemplates();
        return res.json({ ok: true, message: `Template "${name}" deleted` });
    }

    if (action === 'get') {
        if (!name) return res.status(400).json({ ok: false, error: 'missing name' });
        if (!templates[name]) return res.status(404).json({ ok: false, error: 'template not found' });
        return res.json({ ok: true, template: { name, ...templates[name] } });
    }

    res.status(400).json({ ok: false, error: 'invalid action (add/list/del/get)' });
});

// ===================== SCHEDULE ENDPOINTS =====================
app.post('/schedule', authCheck, (req, res) => {
    const { action, id, time, templateName, enabled } = req.body || {};

    if (action === 'add') {
        if (!time || !templateName) {
            return res.status(400).json({ ok: false, error: 'missing time or templateName' });
        }
        // Validate time format HH:MM
        if (!/^\d{2}:\d{2}$/.test(time)) {
            return res.status(400).json({ ok: false, error: 'time format must be HH:MM' });
        }
        if (!templates[templateName]) {
            return res.status(400).json({ ok: false, error: `template "${templateName}" not found` });
        }
        const newId = generateId();
        schedules[newId] = {
            time,
            templateName,
            enabled: true,
            createdAt: nowISO(),
            lastRun: null
        };
        saveSchedules();
        return res.json({ ok: true, id: newId, message: `Schedule added: ${time} → ${templateName}` });
    }

    if (action === 'list') {
        const list = Object.entries(schedules).map(([sid, s]) => ({
            id: sid,
            ...s
        }));
        return res.json({ ok: true, schedules: list });
    }

    if (action === 'del') {
        if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
        if (!schedules[id]) return res.status(404).json({ ok: false, error: 'schedule not found' });
        delete schedules[id];
        saveSchedules();
        return res.json({ ok: true, message: `Schedule "${id}" deleted` });
    }

    if (action === 'toggle') {
        if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
        if (!schedules[id]) return res.status(404).json({ ok: false, error: 'schedule not found' });
        schedules[id].enabled = !schedules[id].enabled;
        saveSchedules();
        return res.json({ ok: true, enabled: schedules[id].enabled });
    }

    res.status(400).json({ ok: false, error: 'invalid action (add/list/del/toggle)' });
});

// ===================== START WA =====================
async function startWA() {
    const { state, saveCreds } = await useMultiFileAuthState('./wa-auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📲 SCAN QR WHATSAPP:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp connected!');
            console.log(`📊 Loaded ${Object.keys(contacts).length} contacts, ${Object.keys(templates).length} templates, ${Object.keys(schedules).length} schedules`);
            await tgSendMessage(LOG_GROUP_ID,
                `✅ WA Bridge CONNECTED\n` +
                `📊 Contacts: ${Object.keys(contacts).length}\n` +
                `📋 Templates: ${Object.keys(templates).length}\n` +
                `⏰ Schedules: ${Object.keys(schedules).length}`
            );

            // Auto-register bridge URL with Render
            registerBridgeWithRender();
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`❌ WA disconnected (status: ${statusCode})`);

            if (shouldReconnect) {
                console.log('🔄 Reconnecting in 3 seconds...');
                setTimeout(startWA, 3000);
            } else {
                console.log('⚠️ Session logged out! Hapus folder wa-auth/ lalu restart untuk scan QR ulang.');
                await tgSendMessage(LOG_GROUP_ID, '⚠️ WA LOGGED OUT — perlu scan QR ulang');
            }
        }
    });

    // ===================== RECEIVE WA MESSAGES =====================
    const userSessions = {}; // { jid: { step: 'ID', data: {}, lastActivity: timestamp } }

    // ===================== AUTO-REMINDER INTERVAL =====================
    setInterval(async () => {
        if (!sock) return;
        const now = Date.now();
        for (const [jid, session] of Object.entries(userSessions)) {
            const age = now - (session.lastActivity || now);

            // Cancel form if inactive for 60 minutes
            if (age > 60 * 60 * 1000) {
                delete userSessions[jid];
                await sock.sendMessage(jid, { text: '❌ Waktu pengisian formulir telah habis. Silakan ketik "Deposit" lagi jika ingin melanjutkan.' }).catch(() => { });
                continue;
            }

            // Remind if inactive for 30 minutes
            if (age > 30 * 60 * 1000 && !session.reminded) {
                session.reminded = true;
                await sock.sendMessage(jid, { text: 'Halo kak, formulir deposit kakak sepertinya belum selesai diisi lho. Ada yang bisa kami bantu? (Ketik "Batal" untuk membatalkan formulir)' }).catch(() => { });
            }
        }
    }, 60 * 1000); // Check every 1 minute

    // ===================== WEEKLY AUTO FOLLOW-UP (SAFE MODE) =====================
    // Hanya mengirim ke MAKSIMAL 3 orang per minggu agar sangat aman dari ban
    setInterval(async () => {
        if (!sock) return;
        console.log('🔍 Running Safe Weekly Follow-up (Quota: 3 members)...');
        const now = Date.now();
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
        let sentInThisBatch = 0;
        
        for (const [jid, contact] of Object.entries(contacts)) {
            if (sentInThisBatch >= 3) break; // BERHENTI jika sudah mencapai kuota 3 orang
            
            const lastSeenTs = new Date(contact.lastSeen).getTime();
            const lastFUTs = contact.lastFollowUp ? new Date(contact.lastFollowUp).getTime() : 0;
            const fuCount = contact.followUpCount || 0;
            
            // Kondisi: Inaktif > 7 hari DAN belum mencapai limit 3 kali follow-up per orang
            if ((now - lastSeenTs > SEVEN_DAYS) && (fuCount < 3) && (now - lastFUTs > SEVEN_DAYS)) {
                try {
                    const name = contact.name || 'Kak';
                    const msg = `Halo kak ${name}! 👋\nMichelle kangen nih, sudah seminggu kakak tidak mampir. Ada kendala kah atau ada yang bisa Michelle bantu hari ini? 😊`;
                    
                    console.log(`✉️ [SAFE MODE] Sending Follow-up to ${jid} (${sentInThisBatch + 1}/3)`);
                    await sock.sendMessage(jid, { text: msg });
                    
                    // Update data contact
                    contact.followUpCount = fuCount + 1;
                    contact.lastFollowUp = new Date().toISOString();
                    sentInThisBatch++;
                    
                    // Delay random 15-45 detik antar pesan agar terlihat manusiawi
                    await new Promise(r => setTimeout(r, Math.random() * 30000 + 15000));
                } catch (err) {
                    console.error(`❌ Failed to follow up ${jid}:`, err.message);
                }
            }
        }
        
        if (sentInThisBatch > 0) {
            saveJSON(CONTACTS_FILE, contacts);
            console.log(`✅ Safe Follow-up complete. Sent to ${sentInThisBatch} members.`);
        }
    }, 7 * 24 * 60 * 60 * 1000); // JALAN SEMINGGU SEKALI

    // ===================== DATA SYNC TO RENDER =====================
    setInterval(async () => {
        if (!RENDER_URL) return;
        try {
            await axios.post(`${RENDER_URL}/wa/sync`, {
                contacts,
                activeSessions: Object.keys(userSessions).length
            }, {
                headers: { 'x-bridge-secret': BRIDGE_SECRET },
                timeout: 10000
            });
        } catch (e) {
            console.log('⚠️ Sync to Render failed:', e.message);
        }
    }, 5 * 60 * 1000); // Sync setiap 5 menit

    // ===================== AUTO GACOR UPDATE (Setiap 3 Jam) =====================
    setInterval(async () => {
        if (!sock || !config.playerGroupId) return;
        
        const games = [
            { name: 'Gates of Olympus (Zeus)', rtp: '98%', pattern: '10x Manual, 30x Quick, 50x Turbo' },
            { name: 'Starlight Princess', rtp: '97%', pattern: '20x Auto, 50x Turbo, On/Off DC' },
            { name: 'Mahjong Ways 2', rtp: '96%', pattern: '10x Manual, 70x Turbo' },
            { name: 'Sugar Rush', rtp: '95%', pattern: '30x Auto, 30x Quick' }
        ];

        const selected = games[Math.floor(Math.random() * games.length)];
        const gacorText = `🎰 *INFO BOCORAN GACOR JEMPOL88* 🎰\n\n` +
                          `🔥 Game: *${selected.name}*\n` +
                          `📈 RTP: *${selected.rtp}*\n` +
                          `🛠️ Pola: \`${selected.pattern}\`\n\n` +
                          `🚀 Gas sekarang di: https://jempol88play.com/\n` +
                          `Semoga JP Paus hari ini ya kak! 🙏💰`;

        await sock.sendMessage(config.playerGroupId, { text: gacorText });
        console.log(`📢 Sent Gacor Update to Group: ${config.playerGroupId}`);
    }, 3 * 60 * 60 * 1000); 

    // ===================== WELCOME MESSAGE (WA) =====================
    sock.ev.on('group-participants.update', async (anu) => {
        if (!config.playerGroupId || anu.id !== config.playerGroupId) return;
        if (anu.action === 'add') {
            for (let num of anu.participants) {
                const welcomeText = `🎉 *SELAMAT DATANG DI JEMPOL88!* 🎉\n\n` +
                                    `Halo kak @${num.split('@')[0]}! Selamat bergabung di komunitas JEMPOL88. Michelle siap bantu kakak setiap hari. 😊\n\n` +
                                    `🎁 *Promo Spesial Buat Kakak:* \n` +
                                    `- Bonus New Member 100%\n` +
                                    `- Garansi Kekalahan 100% Saldo Kembali\n\n` +
                                    `🚀 *Link Login:* https://jempol88play.com/\n` +
                                    `📈 *Link RTP:* https://cutt.ly/rtp-j88\n\n` +
                                    `Semoga JP Paus di sini ya kak! 💰💸`;
                
                await sock.sendMessage(anu.id, { 
                    text: welcomeText, 
                    mentions: [num] 
                });
                console.log(`👋 Sent Welcome to WA: ${num}`);
            }
        }
    });

    // ===================== DAILY SUMMARY & SMART FOLLOW-UP =====================
    let lastSummaryDay = null;
    setInterval(async () => {
        const now = new Date();
        const currentHour = now.getHours();
        const currentMin = now.getMinutes();
        const todayStr = now.toDateString();

        // 1. LAPORAN HARIAN (Jam 00:00 Malam)
        if (currentHour === 0 && currentMin === 0 && lastSummaryDay !== todayStr) {
            lastSummaryDay = todayStr;
            const totalMembers = Object.keys(contacts).length;
            const activeToday = Object.values(contacts).filter(c => {
                const lastSeen = new Date(c.lastSeen);
                return (Date.now() - lastSeen.getTime()) < 24 * 60 * 60 * 1000;
            }).length;

            const summaryText = `📊 <b>LAPORAN HARIAN MICHELLE</b>\n\n` +
                                `👥 Total Member WA: <b>${totalMembers}</b>\n` +
                                `🔥 Aktif 24 Jam Terakhir: <b>${activeToday}</b>\n` +
                                `✅ Bot Status: <b>Online</b>\n\n` +
                                `Semangat terus Bosku! Michelle siap kerja lagi besok. 🚀`;
            
            await tgSendMessage(ADMIN_GROUP_ID, summaryText);
            console.log('📊 Sent Daily Summary to Admin');
        }

        // 2. SMART FOLLOW-UP (Setiap jam, cek member yang tidak aktif > 24 jam)
        // Kita hanya kirim follow-up jika member tersebut belum pernah dideposit-kan baru-baru ini.
        if (currentMin === 30) { // Cek setiap menit ke-30
            for (const jid in contacts) {
                const c = contacts[jid];
                const lastSeen = new Date(c.lastSeen).getTime();
                const diff = Date.now() - lastSeen;

                // Jika tidak aktif antara 24-25 jam (biar tidak spam berkali-kali)
                if (diff > 24 * 60 * 60 * 1000 && diff < 25 * 60 * 60 * 1000) {
                    if (!c.lastDepositTime || (Date.now() - c.lastDepositTime) > 48 * 60 * 60 * 1000) {
                        const nudge = `Halo kak ${c.name || ''}! Michelle kangen nih.. 😊\n\n` +
                                      `Cuma mau info kalau hari ini RTP di JEMPOL88 lagi *Gacor parah* loh! Link login masih sama ya kak: https://jempol88play.com/\n\n` +
                                      `Michelle tunggu ya di dalam! 🎰🚀`;
                        
                        try {
                            await sock.sendMessage(jid, { text: nudge });
                            console.log(`⏰ Sent Follow-up nudge to: ${jid}`);
                        } catch (e) {}
                    }
                }
            }
        }
    }, 60 * 1000); // Cek setiap menit

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const m of messages) {
            if (!m.message) continue;
            if (m.key.fromMe) continue;

            const jid = m.key.remoteJid;
            if (!jid) continue;

            // ===== GROUP PLAYER COMMANDS =====
            if (jid.endsWith('@g.us')) {
                const rawText = m.message.conversation || 
                                m.message.extendedTextMessage?.text || 
                                m.message.imageMessage?.caption || 
                                m.message.videoMessage?.caption || 
                                m.message.templateButtonReplyMessage?.selectedId ||
                                m.message.buttonsResponseMessage?.selectedButtonId ||
                                m.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
                                '';
                const lowerText = rawText.toLowerCase();
                const cmd = lowerText.trim();
                
                if (cmd === '!setgrup' || cmd === '!setgroup') {
                    config.playerGroupId = jid;
                    saveConfig();
                    await sock.sendMessage(jid, { text: '✅ *Michelle Aktif!* Grup ini sekarang terdaftar sebagai Grup Player JEMPOL88. Michelle akan menjaga grup ini tetap seru!' });
                } else if (cmd === '!gacor' || cmd === '!testgacor') {
                    const games = [
                        { name: 'Gates of Olympus (Zeus)', rtp: '98%', pattern: '10x Manual, 30x Quick, 50x Turbo' },
                        { name: 'Starlight Princess', rtp: '97%', pattern: '20x Auto, 50x Turbo, On/Off DC' },
                        { name: 'Mahjong Ways 2', rtp: '96%', pattern: '10x Manual, 70x Turbo' },
                        { name: 'Sugar Rush', rtp: '95%', pattern: '30x Auto, 30x Quick' }
                    ];
                    const selected = games[Math.floor(Math.random() * games.length)];
                    const gacorText = `🎰 *INFO BOCORAN GACOR JEMPOL88* 🎰\n\n` +
                                      `🔥 Game: *${selected.name}*\n` +
                                      `📈 RTP: *${selected.rtp}*\n` +
                                      `🛠️ Pola: \`${selected.pattern}\`\n\n` +
                                      `🚀 Gas sekarang di: https://jempol88play.com/\n` +
                                      `Semoga JP Paus hari ini ya kak! 🙏💰`;
                    await sock.sendMessage(jid, { text: gacorText });
                } else if (cmd === '!cekoki') {
                    const khodams = ['Kakek Zeus ⚡', 'Inces Starlight ✨', 'Panda Mahjong 🐼', 'Permen Sugar Rush 🍬', 'Kucing Lucky Neko 🐱'];
                    const khodam = khodams[Math.floor(Math.random() * khodams.length)];
                    await sock.sendMessage(jid, { text: `🔮 *RAMALAN GACOR MICHELLE* 🔮\n\nHari ini Kakak dijaga oleh Khodam: *${khodam}*\n\nMichelle ramalkan kakak bakal JP Paus kalau main di provider Pragmatic jam sekarang! Gas tipis-tipis kak! 🚀🎰` });
                }

                // --- ADMIN ASSISTANT ---
                if (lowerText.includes('admin') || lowerText.includes('@admin')) {
                    await sock.sendMessage(jid, { text: `Halo Kak! Ada yang bisa Michelle bantu? Admin sedang sibuk memproses antrian depo/wd nih. 🙇‍♀️\n\nSambil nunggu, bisa cek info !gacor dulu ya kak! ✨` });
                }

                // --- ANTI-SPAM LINK ---
                if (lowerText.includes('http') || lowerText.includes('.com') || lowerText.includes('.net')) {
                    if (!lowerText.includes('jempol88') && !lowerText.includes('cutt.ly')) {
                        await sock.sendMessage(jid, { text: `⚠️ *PERINGATAN MICHELLE* ⚠️\n\nKakak dilarang menyebarkan link lain di grup JEMPOL88 ya! Mohon hargai member lain. Michelle laporin admin loh nanti kalau bandel! 🤫👊` });
                    }
                }

                continue; // Skip the rest for all group messages
            }

            const pushName = safeStr(m.pushName);

            // Tentukan tipe pesan
            let text = '';
            let msgType = 'TEXT';
            let mediaBuffer = null;
            let mediaFilename = '';
            let lat = null;
            let lon = null;

            if (m.message.conversation) {
                text = m.message.conversation;
                msgType = 'TEXT';
            } else if (m.message.extendedTextMessage?.text) {
                text = m.message.extendedTextMessage.text;
                msgType = 'TEXT';
            } else if (m.message.imageMessage?.caption) {
                text = m.message.imageMessage.caption;
                msgType = 'IMAGE';
            } else if (m.message.videoMessage?.caption) {
                text = m.message.videoMessage.caption;
                msgType = 'VIDEO';
            } else if (m.message.buttonsResponseMessage?.selectedButtonId) {
                text = m.message.buttonsResponseMessage.selectedButtonId;
                msgType = 'TEXT';
            } else if (m.message.listResponseMessage?.singleSelectReply?.selectedRowId) {
                text = m.message.listResponseMessage.singleSelectReply.selectedRowId;
                msgType = 'TEXT';
            } else if (m.message.templateButtonReplyMessage?.selectedId) {
                text = m.message.templateButtonReplyMessage.selectedId;
                msgType = 'TEXT';
            } else if (m.message.pollUpdateMessage) {
                // If it's a poll response, we don't handle the internal encrypted payload here natively without more setup, 
                // but usually the poll response is sent as a poll creation update. 
                // Wait, baileys pollUpdateMessage is complex to decrypt without getMessage.
                // Let's rely on normal text for the menu, it's safer.
                msgType = 'UNKNOWN';
            } else if (m.message.imageMessage) {
                text = safeStr(m.message.imageMessage.caption);
                msgType = 'IMAGE';
                try {
                    mediaBuffer = await downloadMediaMessage(m, 'buffer', {});
                    mediaFilename = 'image.jpg';
                } catch (e) {
                    console.log('❌ Failed to download image:', e.message);
                }
            } else if (m.message.videoMessage) {
                text = safeStr(m.message.videoMessage.caption);
                msgType = 'VIDEO';
                try {
                    mediaBuffer = await downloadMediaMessage(m, 'buffer', {});
                    mediaFilename = 'video.mp4';
                } catch (e) {
                    console.log('❌ Failed to download video:', e.message);
                }
            } else if (m.message.documentMessage) {
                text = safeStr(m.message.documentMessage.caption);
                msgType = 'DOC';
                try {
                    mediaBuffer = await downloadMediaMessage(m, 'buffer', {});
                    mediaFilename = safeStr(m.message.documentMessage.fileName) || 'document.bin';
                } catch (e) {
                    console.log('❌ Failed to download document:', e.message);
                }
            } else if (m.message.stickerMessage) {
                msgType = 'STICKER';
                try {
                    mediaBuffer = await downloadMediaMessage(m, 'buffer', {});
                    mediaFilename = 'sticker.webp';
                } catch (e) {
                    console.log('❌ Failed to download sticker:', e.message);
                }
            } else if (m.message.audioMessage || m.message.pttMessage) {
                msgType = 'AUDIO';
                try {
                    mediaBuffer = await downloadMediaMessage(m, 'buffer', {});
                    mediaFilename = 'audio.ogg';
                } catch (e) {
                    console.log('❌ Failed to download audio:', e.message);
                }
            } else if (m.message.locationMessage) {
                msgType = 'LOCATION';
                lat = m.message.locationMessage.degreesLatitude;
                lon = m.message.locationMessage.degreesLongitude;
                text = `Location: ${lat}, ${lon}`;
            } else if (m.message.contactMessage) {
                msgType = 'CONTACT';
                text = `Contact: ${safeStr(m.message.contactMessage.displayName)}`;
            } else {
                msgType = 'UNKNOWN';
            }

            // ===== AUTO-SAVE CONTACT =====
            saveContact(jid, pushName, lat, lon);

            console.log(`📩 WA IN [${msgType}]: ${jid} | ${pushName} | ${text || '(no text)'}`);

            // ===== LOCATION AUTO-REPLY =====
            if (msgType === 'LOCATION') {
                try {
                    await sock.sendMessage(jid, { text: 'Terima kasih kak! Lokasi kamu sudah kami catat untuk info promo menarik terdekat dari area kamu ya! 📍✨' });
                } catch (e) {
                    console.log('❌ Failed to reply location:', e.message);
                }
            }

            // ===== FORMULIR DEPOSIT (STATE MACHINE) =====
            const session = userSessions[jid];
            if (session) {
                session.lastActivity = Date.now();

                if (text.toLowerCase() === 'batal' || text.toLowerCase() === 'cancel') {
                    delete userSessions[jid];
                    await sock.sendMessage(jid, { text: '❌ Proses deposit dibatalkan.' });
                    continue;
                }

                if (session.step === 'ID') {
                    session.data.id = text;
                    session.step = 'AMOUNT';
                    await sock.sendMessage(jid, { text: 'Berapa nominal depositnya? (Misal: 50000)\n\n*Ketik "Batal" untuk membatalkan*' });
                    continue;
                }

                if (session.step === 'AMOUNT') {
                    session.data.amount = text;
                    session.step = 'BANK';
                    await sock.sendMessage(jid, { text: 'Ke Bank/E-Wallet apa kamu transfer? (Misal: BCA / DANA)\n\n*Ketik "Batal" untuk membatalkan*' });
                    continue;
                }

                if (session.step === 'BANK') {
                    session.data.bank = text;
                    session.step = 'NAME';
                    await sock.sendMessage(jid, { text: 'Atas nama rekening pengirim siapa?\n\n*Ketik "Batal" untuk membatalkan*' });
                    continue;
                }

                if (session.step === 'NAME') {
                    session.data.name = text;
                    session.step = 'RECEIPT';
                    await sock.sendMessage(jid, { text: 'Terakhir, silakan kirimkan 📸 *FOTO BUKTI TRANSFER* kamu ke sini.\n\n*Ketik "Batal" untuk membatalkan*' });
                    continue;
                }

                if (session.step === 'RECEIPT') {
                    if (msgType !== 'IMAGE' || !mediaBuffer) {
                        await sock.sendMessage(jid, { text: '⚠️ Harap kirimkan FOTO (Gambar) bukti transfer kamu ya.' });
                        continue;
                    }

                    // --- AI VISION RECEIPT CHECKER ---
                    const base64Img = mediaBuffer.toString('base64');
                    const aiResult = await verifyReceiptAI(base64Img);

                    if (aiResult === 'NO') {
                        await sock.sendMessage(jid, { text: '❌ Sistem AI kami mendeteksi bahwa foto ini **bukan** merupakan bukti transfer yang valid. Tolong kirim foto struk asli ya kak!' });
                        continue;
                    }
                    // ---------------------------------

                    session.data.receipt = mediaBuffer;
                    session.data.filename = mediaFilename;

                    // Track Deposit Time
                    const contact = contacts[jid] || {};
                    contact.lastDepositTime = Date.now();
                    saveJSON(CONTACTS_FILE, contacts);

                    await sock.sendMessage(jid, { text: '✅ Terima kasih! Formulir deposit kamu sedang diproses oleh admin. Mohon ditunggu ya kak. 🙏' });

                    const caption = `💰 <b>DEPOSIT BARU</b>\n\n` +
                        `👤 WA: <code>${jid.split('@')[0]}</code>\n` +
                        `📛 Nama WA: ${pushName}\n` +
                        `💳 User ID: ${session.data.id}\n` +
                        `💵 Nominal: ${session.data.amount}\n` +
                        `🏦 Tujuan: ${session.data.bank}\n` +
                        `👨‍💼 A/N Pengirim: ${session.data.name}\n\n#DEPOSIT_FORM`;

                    await forwardToRender({
                        jid,
                        pushName,
                        text: caption,
                        type: 'IMAGE',
                        mediaBuffer: session.data.receipt,
                        mediaFilename: session.data.filename
                    });

                    delete userSessions[jid];
                    continue;
                }

                // --- RESET PASSWORD FLOW ---
                if (session.step === 'FORGET_ID') {
                    session.data.id = text;
                    session.step = 'FORGET_BANK';
                    await sock.sendMessage(jid, { text: '🏦 Mohon masukkan *Nama Bank* terdaftar kamu:' });
                    continue;
                }
                if (session.step === 'FORGET_BANK') {
                    session.data.bank = text;
                    session.step = 'FORGET_NAME';
                    await sock.sendMessage(jid, { text: '👨‍💼 Masukkan *Nama Rekening* (Atas Nama) terdaftar kamu:' });
                    continue;
                }
                if (session.step === 'FORGET_NAME') {
                    session.data.name = text;
                    session.step = 'FORGET_NUM';
                    await sock.sendMessage(jid, { text: '💳 Terakhir, masukkan *Nomor Rekening* terdaftar kamu:' });
                    continue;
                }
                if (session.step === 'FORGET_NUM') {
                    session.data.num = text;
                    
                    await sock.sendMessage(jid, { text: '✅ Permintaan reset password sedang diproses oleh admin. Mohon tunggu 3-5 menit ya kak. 🙏' });
                    
                    const forgetText = `🔐 <b>LUPA PASSWORD (VERIFIKASI)</b>\n\n` +
                                       `👤 WA: <code>${jid.split('@')[0]}</code>\n` +
                                       `📛 Nama WA: ${pushName}\n` +
                                       `💳 User ID: ${session.data.id}\n` +
                                       `🏦 Bank: ${session.data.bank}\n` +
                                       `👨‍💼 Nama Rek: ${session.data.name}\n` +
                                       `🔢 No Rek: ${session.data.num}\n\n#FORGET_PASSWORD`;
                    
                    await forwardToRender({ jid, pushName, text: forgetText, type: 'TEXT' });
                    delete userSessions[jid];
                    continue;
                }
            }

            // ===== TRIGGER DEPOSIT FORM =====
            if (msgType === 'TEXT' && text.toLowerCase() === 'deposit') {
                userSessions[jid] = { step: 'ID', data: {}, lastActivity: Date.now() };
                await sock.sendMessage(jid, { text: '📝 *Formulir Deposit*\n\nSilakan ketik *User ID* akun kamu:\n\n*Ketik "Batal" untuk membatalkan*' });
                continue;
            }

            // ===== TRIGGER FORGET PASSWORD =====
            if (msgType === 'TEXT' && (text.toLowerCase().includes('lupa password') || text.toLowerCase().includes('reset password'))) {
                userSessions[jid] = { step: 'FORGET_ID', data: {}, lastActivity: Date.now() };
                await sock.sendMessage(jid, { text: '🔐 *Verifikasi Lupa Password*\n\nSilakan ketik *User ID* akun kamu:\n\n*Ketik "Batal" untuk membatalkan*' });
                continue;
            }
            // ===== CHAT AI (GEMINI) =====
            if (!jid.endsWith('@g.us')) {
                await forwardToRender({
                    jid,
                    pushName,
                    text,
                    type: msgType,
                    mediaBuffer,
                    mediaFilename
                });
            }
            continue;

            // ===== Notifikasi ke Telegram (Dihapus agar tidak spam, karena server.js sudah membuat tiket) =====
            /*
            await tgSendMessage(
                ADMIN_GROUP_ID,
                `📩 WA MASUK\n` +
                `📱 JID: ${jid}\n` +
                `👤 Name: ${pushName}\n` +
                `📎 Type: ${msgType}\n` +
                `💬 Text: ${text || '(no text)'}\n` +
                `🕐 Time: ${nowISO()}`
            );
            */
        }
    });
}

// ===================== AUTO-REGISTER BRIDGE URL WITH RENDER =====================
async function registerBridgeWithRender() {
    if (!RENDER_URL) return;
    try {
        // Try to get current public URL (ngrok or similar)
        let bridgeUrl = process.env.WA_BRIDGE_URL || `http://localhost:${WA_PORT}`;
        
        console.log(`📡 Registering bridge URL with Render: ${bridgeUrl}`);
        const headers = {};
        if (BRIDGE_SECRET) headers['x-bridge-secret'] = BRIDGE_SECRET;
        
        await axios.post(`${RENDER_URL}/wa/register-bridge`, {
            bridgeUrl: bridgeUrl
        }, {
            headers,
            timeout: 10000
        });
        console.log('✅ Bridge URL registered with Render successfully');
    } catch (e) {
        console.log('⚠️ Failed to register bridge URL with Render:', e.message);
    }
}

// Heartbeat: Re-register every 5 minutes to keep URL fresh
setInterval(registerBridgeWithRender, 5 * 60 * 1000);

// ===================== RUN =====================
app.listen(WA_PORT, () => {
    console.log(`🚀 WA Bridge running on port ${WA_PORT}`);
    console.log(`📡 RENDER_URL: ${RENDER_URL || '(not set)'}`);
    console.log(`📊 Contacts: ${Object.keys(contacts).length} | Templates: ${Object.keys(templates).length} | Schedules: ${Object.keys(schedules).length}`);
    startWA();
});