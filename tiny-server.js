const http = require('http');
const { URL } = require('url');
const fs = require('fs/promises');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createResponse(res) {
  let statusCode = 200;
  let sent = false;
  const api = {
    get sent() {
      return sent;
    },
    status(code) {
      statusCode = code;
      return api;
    },
    setHeader(name, value) {
      if (!sent) {
        res.setHeader(name, value);
      }
      return api;
    },
    send(body = '') {
      if (sent) return api;
      res.statusCode = statusCode;
      if (Buffer.isBuffer(body)) {
        res.end(body);
      } else if (typeof body === 'string') {
        res.end(body);
      } else {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(body ?? {}));
      }
      sent = true;
      return api;
    },
    json(obj) {
      if (sent) return api;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return api.send(JSON.stringify(obj ?? {}));
    },
    async sendFile(filePath) {
      if (sent) return api;
      try {
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const type = MIME_TYPES[ext] || 'application/octet-stream';
        res.setHeader('Content-Type', type);
        return api.send(data);
      } catch (err) {
        return api.status(err?.code === 'ENOENT' ? 404 : 500).send(err?.code === 'ENOENT' ? 'Not Found' : 'Error');
      }
    }
  };
  return api;
}

function createApp() {
  const routes = [];
  const statics = [];

  const addRoute = (method, routePath, handler) => {
    routes.push({ method, routePath, handler });
  };

  const findRoute = (method, pathname) => {
    return routes.find((route) => route.method === method && route.routePath === pathname);
  };

  const addStatic = (prefix, dir) => {
    const cleanPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    statics.push({ prefix: cleanPrefix, dir });
  };

  const resolveStatic = async (req, res) => {
    for (const entry of statics) {
      if (req.path === entry.prefix || req.path.startsWith(entry.prefix + '/')) {
        const rel = req.path.slice(entry.prefix.length).replace(/^\//, '');
        const filePath = path.join(entry.dir, rel || '');
        const stats = await fs.stat(filePath).catch(() => null);
        if (!stats) {
          continue;
        }
        if (stats.isDirectory()) {
          const indexFile = path.join(filePath, 'index.html');
          return res.sendFile(indexFile);
        }
        return res.sendFile(filePath);
      }
    }
    return false;
  };

  const serverHandler = async (req, res) => {
    const parsed = new URL(req.url, 'http://localhost');
    req.path = parsed.pathname;
    req.query = Object.fromEntries(parsed.searchParams.entries());
    req.body = await readBody(req);

    const response = createResponse(res);
    const route = findRoute(req.method, req.path);
    if (route) {
      try {
        await route.handler(req, response);
      } catch (err) {
        console.error('Request error:', err?.message || err);
        if (!response.sent) {
          response.status(500).send('Internal Server Error');
        }
      }
      return;
    }

    if (await resolveStatic(req, response) !== false) {
      return;
    }

    if (!response.sent) {
      response.status(404).send('Not Found');
    }
  };

  return {
    get(pathname, handler) {
      addRoute('GET', pathname, handler);
    },
    post(pathname, handler) {
      addRoute('POST', pathname, handler);
    },
    static(prefix, dir) {
      addStatic(prefix, dir);
    },
    listen(port, cb) {
      const server = http.createServer((req, res) => {
        serverHandler(req, res).catch((err) => {
          console.error('Server error:', err?.message || err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Internal Server Error');
          }
        });
      });
      return server.listen(port, cb);
    }
  };
}

module.exports = { createApp };
