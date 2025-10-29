const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const DB_FILE = './db.sqlite';
const SQL = fs.readFileSync('./schema.sql', 'utf8');

const db = new sqlite3.Database(DB_FILE);
db.exec(SQL, (err) => {
  if (err) {
    console.error('DB init error', err);
  } else {
    console.log('✅ DB initialized and rules inserted.');
  }
  db.close();
});