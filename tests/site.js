const http = require('node:http');

const page = ({ title = 'Acme Demo', h1 = 'Welcome', nav = true, body = '', head = '', lang = 'en', v2 = false } = {}) => `<!doctype html>
<html${lang ? ` lang="${lang}"` : ''}><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Demo site">${head}</head>
<body>${nav ? `<header><nav aria-label="Main">
<a href="/">Home</a> <a href="/about">About</a> <a href="/products">Products</a>${v2 ? '' : ' <a href="/contact">Contact</a>'}
<a href="/logout">Log out</a> <a href="/files/report.pdf">Report</a>
</nav></header>` : ''}<main>${h1 ? `<h1>${h1}</h1>` : ''}${body}</main>
<footer><a href="/missing">Old page</a> <a href="/broken">Broken demo</a> <a href="mailto:hi@example.com">Email us</a></footer></body></html>`;

const contactForm = (v2) => `<form id="contact" action="/contact" method="post">
<label for="name">Name</label><input id="name" name="name" required minlength="2">
${v2 ? '' : '<label for="email">Email</label><input id="email" name="email" type="email" required>'}
<label for="age">Age</label><input id="age" name="age" type="number" min="18" max="99">
<label for="topic">Topic</label><select id="topic" name="topic"><option value="sales">Sales</option><option value="support">Support</option></select>
<label for="message">Message</label><textarea id="message" name="message" required minlength="10"></textarea>
<input type="text" name="bot-field" style="display:none">
<button type="submit">Send</button></form>`;

function createSite() {
  const state = { variant: 'v1', posts: [], hits: [] };
  const server = http.createServer((req, res) => {
    const v2 = state.variant === 'v2';
    const url = new URL(req.url, 'http://x');
    state.hits.push(`${req.method} ${url.pathname}`);
    const html = (body, status = 200) => res.writeHead(status, { 'content-type': 'text/html' }).end(body);
    const json = (body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));

    if (req.method === 'POST') {
      state.posts.push(url.pathname);
      return html('<h1>Thanks</h1>');
    }
    switch (url.pathname) {
      case '/': return html(page({ body: '<p>Home page</p>', v2 }));
      case '/about': return html(page({ title: v2 ? 'About us (new)' : 'About', h1: 'About', body: '<p>About us</p>', v2 }));
      case '/products':
        return html(page({
          title: 'Products', h1: 'Products', v2,
          body: '<p id="list"></p><script>fetch("/api/products").then(r=>r.json()).then(d=>{document.getElementById("list").textContent=d.map(p=>p.name).join(", ")})</script>',
        }));
      case '/api/products':
        return json(v2 ? [{ id: 1, name: 'Widget', price: '9.99' }] : [{ id: 1, name: 'Widget', price: 9.99 }, { id: 2, name: 'Gadget', price: 19.5 }]);
      case '/contact': return html(page({ title: 'Contact', h1: 'Contact us', body: contactForm(v2), v2 }));
      case '/broken':
        return html(page({ title: 'Broken', h1: '', body: '<img src="/missing.png"><script>console.error("boom")</script>', v2 }));
      case '/logout': return html('<h1>Signed out</h1>');
      case '/files/report.pdf': return res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF');
      default: return html('<h1>Not found</h1>', 404);
    }
  });
  return { server, state };
}

module.exports = { createSite };
