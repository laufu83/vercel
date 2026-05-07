const express = require('express');
const serverless = require('serverless-http');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: process.env.TIDB_PORT || 4000,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
});

// 表白名单
const ALLOW_TABLES = ["vod_dytt", "vod_ffzy"];
function isSafeTable(table) {
  return ALLOW_TABLES.includes(table);
}

// 列表接口（支持 type 筛选）
app.get('/api/:tablename/list', async (req, res) => {
  try {
    const { tablename } = req.params;
    if (!isSafeTable(tablename)) return res.json({ code: 0, msg: "表名不合法" });

    const page = parseInt(req.query.page) || 1;
    const size = parseInt(req.query.size) || 10;
    const offset = (page - 1) * size;

    // 修复 type 筛选：转为数字
    const type_id = req.query.type ? parseInt(req.query.type) : null;

    let where = "WHERE 1=1";
    let params = [];

    if (type_id) {
      where += " AND type_id = ?";
      params.push(type_id);
    }

    const [rows] = await pool.query(
      `SELECT vod_id, type_id, type_name, type_id_1, vod_name, vod_sub, 
        vod_en, vod_letter, vod_class, vod_pic, vod_actor, 
        vod_director, vod_area, vod_lang, vod_year, 
        vod_douban_id, vod_douban_score, vod_remarks, vod_score FROM ${tablename} ${where} ORDER BY vod_time DESC LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );

    const [total] = await pool.query(
      `SELECT COUNT(*) AS count FROM ${tablename} ${where}`,
      params
    );

    res.json({
      code: 1,
      page,
      size,
      total: total[0].count,
      data: rows
    });

  } catch (err) {
    res.json({ code: 0, msg: err.message });
  }
});

// 详情接口
app.get('/api/:tablename/detail', async (req, res) => {
  try {
    const { tablename } = req.params;
    if (!isSafeTable(tablename)) return res.json({ code: 0, msg: "表名不合法" });

    const { vod_id } = req.query;
    if (!vod_id) return res.json({ code: 0, msg: "vod_id 不能为空" });

    const [rows] = await pool.query(`SELECT * FROM ${tablename} WHERE vod_id = ?`, [vod_id]);
    res.json({ code: 1, data: rows[0] || null });
  } catch (err) {
    res.json({ code: 0, msg: err.message });
  }
});

// 搜索接口
app.get('/api/:tablename/search', async (req, res) => {
  try {
    const { tablename } = req.params;
    if (!isSafeTable(tablename)) return res.json({ code: 0, msg: "表名不合法" });

    const keyword = req.query.keyword || "";
    const page = parseInt(req.query.page) || 1;
    const size = parseInt(req.query.size) || 10;
    const offset = (page - 1) * size;
    const kw = `%${keyword}%`;

    const [rows] = await pool.query(
      `SELECT vod_id, type_id, type_name, type_id_1, vod_name, vod_sub, 
        vod_en, vod_letter, vod_class, vod_pic, vod_actor, 
        vod_director, vod_area, vod_lang, vod_year, 
        vod_douban_id, vod_douban_score, vod_remarks, vod_score FROM ${tablename} WHERE vod_name LIKE ? ORDER BY vod_time DESC LIMIT ? OFFSET ?`,
      [kw, size, offset]
    );

    res.json({ code: 1, keyword, data: rows });
  } catch (err) {
    res.json({ code: 0, msg: err.message });
  }
});
module.exports = app;
module.exports.handler = serverless(app);
