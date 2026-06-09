// 👉 必须放在所有 import 之前
declare module "express-session" {
  interface SessionData {
    views?: number;
    userId?: number;
    userAgent?: string;
  }
}

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import session from "express-session";

// 路由
import authRouter from "./router/auth";
import movieRouter from "./router/movie";
import s3Router from "./router/s3";

const app = express();
app.use(express.json());

// 会话配置
app.use(
  session({
    secret: process.env.SESSION_SECRET || "default_secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

// ✅ 测试接口（完全不报错）
app.get("/api/test", (req, res) => {
  res.json({
    code: 200,
    msg: "✅ 服务运行正常！",
    sessionId: req.session.id, // 只有这个是官方自带属性，绝对不报错
  });
});

// 业务路由
app.use("/api/auth", authRouter);
app.use("/api/vod", movieRouter);
app.use("/api/s3", s3Router);

// 404
app.use((req, res) => {
  res.status(404).json({
    code: 404,
    msg: "API 不存在：" + req.url,
  });
});

module.exports = app;