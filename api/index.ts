import express from 'express';
import serverless from 'serverless-http';
import session from 'express-session';
import authRouter from './router/auth';
import movieRouter from './router/movie';
import s3Router from './router/s3';

const app = express();

app.use(express.json());

// Session 配置
app.use(session({
  secret: process.env.SESSION_SECRET || 'vercel-express-server',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 300000 }
}));

// ✅ Vercel 正确路由前缀（关键！）
app.use("/api/auth",authRouter);
app.use("/api/vod",movieRouter);
app.use("/api/s3",s3Router);

// ✅ 兜底 404
app.use((req, res) => {
  return res.status(404).json({ code: 404, msg: 'API 路径不存在：' + req.url });
});

// 👇 本地直接运行
// if (require.main === module) {
//   app.listen(3000, () => {
//     console.log('✅ 服务运行在 http://localhost:3000');
//   });
// }
// ✅ Vercel 固定导出
export const handler = serverless(app);
