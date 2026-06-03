require('dotenv').config();
const axios = require('axios');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LOCAL_WEBHOOK_URL = 'http://localhost:10000/webhook';
let offset = 0;

console.log('Starting Telegram Poller for Local Testing...');
console.log('Forwarding updates to:', LOCAL_WEBHOOK_URL);

async function init() {
    await axios.get(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`);
    console.log('Webhook deleted from Telegram (to allow polling)');
    poll();
}

async function poll() {
    try {

        const res = await axios.get(`https://api.telegram.org/bot${TOKEN}/getUpdates`, {
            params: { offset, timeout: 30 }
        });

        if (res.data && res.data.ok) {
            for (const update of res.data.result) {
                offset = update.update_id + 1;
                
                try {
                    await axios.post(LOCAL_WEBHOOK_URL, update);
                    console.log(`Forwarded update ${update.update_id} to local server`);
                } catch (postErr) {
                    console.error('Failed to forward update (Is local server running?):', postErr.message);
                }
            }
        }
    } catch (err) {
        console.error('Polling error:', err.response?.data || err.message);
    }
    
    setTimeout(poll, 1000);
}

init();
