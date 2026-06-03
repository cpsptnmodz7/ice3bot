const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'server.js');
let content = fs.readFileSync(filePath, 'utf-8');

// Revert Michelle back to Melody
content = content.replace(/Michelle/g, 'Melody');
content = content.replace(/michelle/g, 'melody');

fs.writeFileSync(filePath, content, 'utf-8');

// Rename knowledge file back
const oldKPath = path.join(__dirname, 'data', 'michelle_knowledge.txt');
const newKPath = path.join(__dirname, 'data', 'melody_knowledge.txt');
if (fs.existsSync(oldKPath)) {
    let kContent = fs.readFileSync(oldKPath, 'utf-8');
    kContent = kContent.replace(/Michelle/g, 'Melody');
    fs.writeFileSync(newKPath, kContent, 'utf-8');
    fs.unlinkSync(oldKPath);
}

console.log('Reverted persona name to Melody!');
