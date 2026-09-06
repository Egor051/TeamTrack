const http = require('http');
http.get('http://127.0.0.1:8095/_sitemap', (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => console.log(body));
}).on('error', (error) => { console.error(error.message); process.exitCode = 1; });
