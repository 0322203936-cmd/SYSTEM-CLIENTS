const fs = require('fs');
const pdf = require('pdf-parse');
const data = fs.readFileSync('C:/Users/Yisus/.gemini/antigravity-ide/brain/06ddc21c-3d0d-4e03-9b2b-ede2bc712256/media__1786756847670.pdf');
pdf(data).then(res => console.log(res.text));
