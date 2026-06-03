const fs = require('fs');
const path = require('path');

// Fix wa-bridge.js: Michelle -> Melody
const waPath = path.join(__dirname, 'wa-bridge.js');
if (fs.existsSync(waPath)) {
    let content = fs.readFileSync(waPath, 'utf-8');
    content = content.replace(/Michelle/g, 'Melody');
    content = content.replace(/michelle/g, 'melody');
    content = content.replace(/MICHELLE/g, 'MELODY');
    fs.writeFileSync(waPath, content, 'utf-8');
    console.log('wa-bridge.js: Michelle -> Melody (done)');
}

// Double-check server.js too
const serverPath = path.join(__dirname, 'server.js');
let sContent = fs.readFileSync(serverPath, 'utf-8');
const michelleCount = (sContent.match(/Michelle/gi) || []).length;
if (michelleCount > 0) {
    sContent = sContent.replace(/Michelle/g, 'Melody');
    sContent = sContent.replace(/michelle/g, 'melody');
    sContent = sContent.replace(/MICHELLE/g, 'MELODY');
    fs.writeFileSync(serverPath, sContent, 'utf-8');
    console.log(`server.js: Fixed ${michelleCount} remaining Michelle -> Melody`);
} else {
    console.log('server.js: Already all Melody (OK)');
}

// Check knowledge file
const kPath1 = path.join(__dirname, 'data', 'michelle_knowledge.txt');
const kPath2 = path.join(__dirname, 'data', 'melody_knowledge.txt');
if (fs.existsSync(kPath1)) {
    let k = fs.readFileSync(kPath1, 'utf-8');
    k = k.replace(/Michelle/g, 'Melody');
    fs.writeFileSync(kPath2, k, 'utf-8');
    fs.unlinkSync(kPath1);
    console.log('Renamed michelle_knowledge.txt -> melody_knowledge.txt');
}
if (fs.existsSync(kPath2)) {
    let k = fs.readFileSync(kPath2, 'utf-8');
    if (k.includes('Michelle')) {
        k = k.replace(/Michelle/g, 'Melody');
        fs.writeFileSync(kPath2, k, 'utf-8');
        console.log('melody_knowledge.txt: Fixed Michelle -> Melody');
    } else {
        console.log('melody_knowledge.txt: Already all Melody (OK)');
    }
}

console.log('\nAll done! Bot name is now fully Melody everywhere.');
