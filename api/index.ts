import dotenv from 'dotenv';
dotenv.config(); // 必须第一行

import express from 'express';
import serverless from 'serverless-http';
import session from 'express-session';
import RedisStore from 'connect-redis';

// 直接复用你写好的 Redis 工具
import { getRedisClient } from './redis';

// 路由
import authRouter from './router/auth';
import movieRouter from './router/movie';
import s3Router from './router/s3';

const app = express();
app.use(express.json());

// ==========================================
// 🔥 复用你的 Redis 客户端给 Session 使用
// ==========================================
let redisStore: any;
(async () => {
  const client = await getRedisClient();
  if (client) {
    redisStore = new RedisStore({
      client,
      prefix: 'session:',
    });
    console.log('✅ Session 已启用 Redis 存储');
  }
})();

// ==========================================
// ✅ Session 配置（Serverless 稳定版）
// ==========================================
app.use(session({
  store: redisStore, // 这里直接用你的 Redis
  secret: process.env.SESSION_SECRET || 'vercel-express-server',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  },
}));

// ==========================================
// 路由
// ==========================================
app.use("/api/auth", authRouter);
app.use("/api/vod", movieRouter);
app.use("/api/s3", s3Router);

// ==========================================
// 404
// ==========================================
app.use((req, res) => {
  return res.status(404).json({
    code: 404,
    msg: 'API 路径不存在：' + req.url
  });
});
// 本地直接运行
// if (require.main === module) {
//   app.listen(3000, () => {
//     console.log('✅ 服务运行在 http://localhost:3000');
//   });
// }
// ==========================================
// Vercel 导出（必须）
// ==========================================
export default serverless(app);