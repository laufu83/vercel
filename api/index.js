const express = require('express');
const serverless = require('serverless-http');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

// 数据库连接
const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: process.env.TIDB_PORT || 4000,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: { rejectUnauthorized: false },
});

// 表白名单
const ALLOW_TABLES = ["vod_dytt", "vod_ffzy"];
function checkTable(table) {
  return ALLOW_TABLES.includes(table);
}

// ====================== 接口 ======================
app.get('/api/:tablename/list', async (req, res) => {
  try {
    const { tablename } = req.params;
    if (!checkTable(tablename)) return res.json({ code: 0, msg: "表不合法" });

    const page = parseInt(req.query.page) || 1;
    const size = parseInt(req.query.size) || 10;
    const offset = (page - 1) * size;

    const [rows] = await pool.query(`SELECT * FROM ${tablename} LIMIT ? OFFSET ?`, [size, offset]);
    res.json({ code: 1, data: rows });
  } catch (e) {
    res.json({ code: 0, msg: e.message });
  }
});

app.get('/api/:tablename/detail', async (req, res) => {
  try {
    const { tablename } = req.params;
    if (!checkTable(tablename)) return res.json({ code: 0, msg: "表不合法" });
    const { vod_id } = req.query;
    const [rows] = await pool.query(`SELECT * FROM ${tablename} WHERE vod_id=?`, [vod_id]);
    res.json({ code: 1, data: rows[0] });
  } catch (e) {
    res.json({ code: 0, msg: e.message });
  }
});

// 导出给 Vercel
module.exports = app;
module.exports.handler = serverless(app);
