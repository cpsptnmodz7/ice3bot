const axios = require('axios');
require('dotenv').config();

async function listModels() {
    const key = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
    
    try {
        const res = await axios.get(url);
        console.log('✅ Daftar Model Tersedia:');
        res.data.models.forEach(m => console.log('-', m.name));
    } catch (e) {
        console.log('❌ GAGAL list models:', e.response?.data?.error?.message || e.message);
    }
}

listModels();
