import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();
export const pool = mysql.createPool({
  host: process.env.TIDB_HOST!,
  port: Number(process.env.TIDB_PORT) || 4000,
  user: process.env.TIDB_USER!,
  password: process.env.TIDB_PASSWORD!,
  database: process.env.TIDB_DATABASE!,
  ssl: { rejectUnauthorized: false },
  connectionLimit: 1,
  connectTimeout: 5000, // 🔥 5 秒连不上就放弃
});