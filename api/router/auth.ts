import { Router, Request, Response, NextFunction } from "express";
import { pool } from "../db";
import { kv } from "../redis";
import { snakeToCamel, generateCode, createCaptcha, Logger } from "../utils";
import { errorResponse, successResponse, authMiddleware } from "../middleware";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const router = Router();
// ==========================
// 类型定义
// ==========================
interface Env {
  RESEND_API_KEY: string;
  HOST: string;
}

interface RefreshTokenData {
  userId: string;
  revoked: boolean;
}

interface User {
  user_id: string;
  username: string;
  password: string | null;
  nickname: string;
  email: string | null;
  phone: string | null;
  gender: string | null;
  avatar_url: string | null;
  status: string;
  has_password: boolean;
  created_at: Date | null;
  updated_at: Date | null;
  last_login: Date | null;
  email_verified: boolean;
  email_verify_token: string | null;
  email_verify_expires_at: Date | null;
}

interface VerifyCacheItem {
  contactType: "phone" | "email";
  contactVal: string;
  code: string;
}

// ==========================
// 环境变量初始化 & 校验
// ==========================
const env: Env = {
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
  HOST: process.env.HOST ?? "localhost",
};
if (!env.RESEND_API_KEY) {
  console.warn("警告：未配置 RESEND_API_KEY，邮件发送功能将失效");
}
// ==========================
// 格式校验工具
// ==========================
function isValidEmail(email: string): boolean {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function isValidPhone(phone: string): boolean {
  const re = /^1[3-9]\d{9}$/;
  return re.test(phone);
}
// ==========================
// 邮件工具
// ==========================
async function sendMail(to: string, subject: string, html: string) {
  if (!env.RESEND_API_KEY) {
    return { success: false, error: new Error("未配置邮件密钥") };
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "系统通知 <admin@fred.dpdns.org>",
        to: [to],
        subject: subject,
        html: html,
      }),
    });
    const result = await response.json();
    console.log("Resend 发送结果:", result);
    return { success: response.ok, status: response.status, data: result };
  } catch (err) {
    console.error("Resend 邮件发送失败", err);
    return { success: false, error: err };
  }
}

async function sendActivationEmail(
  targetEmail: string,
  verifyToken: string,
  logger: Logger,
) {
  const activeUrl = `https://${env.HOST}/email/verify?token=${verifyToken}`;
  const html = `
    <h3>邮箱激活</h3>
    <p>点击链接完成账号激活：<a href="${activeUrl}">${activeUrl}</a></p>
    <p>链接24小时内有效</p>
  `;
  logger.info("发送激活邮件", { targetEmail, activeUrl });
  // 存入激活凭证KV，修复原逻辑未存储导致激活失效bug
  await kv.set(`activate:${verifyToken}`, targetEmail, 24 * 3600);
  await sendMail(targetEmail, "账号邮箱激活", html);
}

async function sendCodeEmail(
  targetEmail: string,
  code: string,
  logger: Logger,
) {
  const html = `
    <h3>您的验证码</h3>
    <p>验证码：<b>${code}</b></p>
    <p>5分钟内有效，请勿泄露给他人</p>
  `;
  logger.info("发送邮箱验证码", { targetEmail, code });
  await sendMail(targetEmail, "登录/注册验证码", html);
}

// ==========================
// Token 管理
// ==========================
async function createTokens(userId: string, logger: Logger) {
  const accessToken = crypto.randomBytes(32).toString("hex");
  const refreshToken = crypto.randomBytes(40).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  logger.db("INSERT refresh_tokens", { userId });
  await pool.query(
    "INSERT INTO refresh_tokens (token, user_id, expires_at, created_at, revoked, status) VALUES (?, ?, ?, ?, false, ?)",
    [refreshToken, userId, expiresAt, now, "active"],
  );

  // ✅ 存储 refreshToken（用于刷新）
  await kv.set(
    `rt:${refreshToken}`,
    { userId, revoked: false } satisfies RefreshTokenData,
    7 * 86400,
  );

  // ✅【修复点】存储 accessToken（用于接口鉴权，15分钟过期）
  await kv.set(
    `at:${accessToken}`,
    { userId },
    15 * 60 // 15分钟，标准短有效期
  );

  // 支持多端登录
  const oldRtList = (await kv.get<string[]>(`user:rt:${userId}`)) ?? [];
  oldRtList.push(refreshToken);
  await kv.set(`user:rt:${userId}`, oldRtList, 7 * 86400);

  logger.info("Token生成成功", { userId });
  return { accessToken, refreshToken, expiresIn: 604800 };
}

// ==========================
// 验证码发送 /verification
// ==========================
router.post("/verification", async (req: Request, res: Response) => {
  const logger = new Logger(req);
  try {
    const { phone, email } = req.body;
    if (!phone && !email) {
      return res
        .status(400)
        .json(errorResponse("invalid_param", 400, "手机号或邮箱必填"));
    }

    const contactType: "phone" | "email" = phone ? "phone" : "email";
    const contactVal = phone || email!;
    const code = generateCode();
    const verificationId = uuidv4();

    const limitMinKey = `limit:${contactType}:${contactVal}:min`;
    const limitDayKey = `limit:${contactType}:${contactVal}:day`;
    const failCountKey = `verify_fail:${contactType}:${contactVal}`;

    const minCount = (await kv.get<number>(limitMinKey)) ?? 0;
    const dayCount = (await kv.get<number>(limitDayKey)) ?? 0;
    const failCount = (await kv.get<number>(failCountKey)) ?? 0;

    // 暴力破解限制：连续错误5次锁定10分钟
    if (failCount >= 5) {
      return res
        .status(429)
        .json(
          errorResponse(
            "verify_locked",
            429,
            "验证失败次数过多，请10分钟后重试",
          ),
        );
    }
    if (minCount >= 1)
      return res
        .status(429)
        .json(errorResponse("tooFrequently", 429, "1分钟内限制发送一次"));
    if (dayCount >= 5)
      return res
        .status(429)
        .json(errorResponse("dailyLimit", 429, "今日已达发送上限"));

    await kv.incr(limitMinKey);
    await kv.incr(limitDayKey);
    await kv.set(limitMinKey, minCount + 1, 60);
    await kv.set(limitDayKey, dayCount + 1, 24 * 3600);
    await kv.set(
      `verify:${verificationId}`,
      { contactType, contactVal, code } satisfies VerifyCacheItem,
      300,
    );

    res.json(successResponse({ verificationId, expiresIn: 300 }));
  } catch (e) {
    logger.error("发送验证码失败", e);
    res
      .status(500)
      .json(errorResponse("server_error", 500, (e as Error).message));
  }
});

// ==========================
// 验证码校验 /verification/verify
// ==========================
router.post(
  "/verification/verify",
  async (req: Request, res: Response) => {
    const logger = new Logger(req);
    try {
      const { verificationId, verificationCode } = req.body;
      const cacheData = await kv.get<VerifyCacheItem>(
        `verify:${verificationId}`,
      );
      if (!cacheData) {
        return res
          .status(400)
          .json(errorResponse("invalid_code", 400, "验证码不存在或已过期"));
      }

      const failKey = `verify_fail:${cacheData.contactType}:${cacheData.contactVal}`;
      if (cacheData.code !== verificationCode) {
        await kv.incr(failKey);
        await kv.set(failKey, ((await kv.get<number>(failKey)) ?? 0) + 1, 600);
        return res
          .status(400)
          .json(errorResponse("invalid_code", 400, "验证码错误"));
      }

      // 验证成功清空错误计数
      await kv.del(failKey);
      const token = crypto.randomBytes(20).toString("hex");
      await kv.set(`valid:${token}`, cacheData, 600);
      await kv.del(`verify:${verificationId}`);
      res.json(successResponse({ verificationToken: token }));
    } catch (e) {
      logger.error("验证失败", e);
      res
        .status(500)
        .json(errorResponse("server_error", 500, (e as Error).message));
    }
  },
);

// ==========================
// 注册 /signup
// ==========================
// ==========================
// 【最终版】三合一注册接口
// 1. 用户名+密码注册
// 2. 邮箱验证码注册（自动把邮箱当用户名）
// 3. 手机验证码注册（自动把手机当用户名）
// ==========================
router.post('/signup', async (req: Request, res: Response) => {
  const logger = new Logger(req);
  try {
    const {
      phone, email,
      verificationToken,
      username, password,
      nickname, gender, avatar_url
    } = req.body;

    let validData: VerifyCacheItem | null = null;
    if (!username) {
      if (!verificationToken) {
        return res.status(400).json(errorResponse('invalid_param', 400, '验证凭证不能为空'));
      }
      validData = await kv.get<VerifyCacheItem>(`valid:${verificationToken}`);
      if (!validData) {
        return res.status(400).json(errorResponse('invalid_token', 400, '凭证无效或已过期'));
      }
    }

    let finalUsername = username;
    let finalEmail = email;
    let finalPhone = phone;

    if (validData) {
      if (validData.contactType === 'email') {
        finalEmail = validData.contactVal;
        finalUsername = finalEmail;
      }
      if (validData.contactType === 'phone') {
        finalPhone = validData.contactVal;
        finalUsername = finalPhone;
      }
    }

    // ==========================
    // 【格式校验】在这里！
    // ==========================
    if (finalEmail && !isValidEmail(finalEmail)) {
      return res.status(400).json(errorResponse('invalid_email', 400, '邮箱格式不正确'));
    }
    if (finalPhone && !isValidPhone(finalPhone)) {
      return res.status(400).json(errorResponse('invalid_phone', 400, '手机号格式不正确'));
    }

    if (!finalUsername) {
      return res.status(400).json(errorResponse('invalid_param', 400, '用户名不能为空'));
    }

    // 用户名重复检查
    const [existUser] = await pool.query(
      'SELECT 1 FROM users WHERE username = ?',
      [finalUsername]
    );
    if ((existUser as any[]).length > 0) {
      return res.status(409).json(errorResponse('exists', 409, '用户名已被注册'));
    }

    // 邮箱重复检查
    if (finalEmail) {
      const [e] = await pool.query('SELECT 1 FROM users WHERE email = ?', [finalEmail]);
      if ((e as any[]).length) return res.status(409).json(errorResponse('exists', 409, '邮箱已注册'));
    }

    // 手机重复检查
    if (finalPhone) {
      const [p] = await pool.query('SELECT 1 FROM users WHERE phone = ?', [finalPhone]);
      if ((p as any[]).length) return res.status(409).json(errorResponse('exists', 409, '手机号已注册'));
    }

    const userId = uuidv4();
    const pwd = password ? bcrypt.hashSync(password, 10) : null;

    let emailToken: string | null = null;
    if (finalEmail) {
      emailToken = crypto.randomBytes(32).toString('hex');
      await sendActivationEmail(finalEmail, emailToken, logger);
    }

    await pool.query(`
      INSERT INTO users (
        user_id, username, password, nickname,
        email, phone, gender, avatar_url,
        has_password, email_verified,
        email_verify_token, email_verify_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      finalUsername,
      pwd,
      nickname || '',
      finalEmail || null,
      finalPhone || null,
      gender || null,
      avatar_url || null,
      !!pwd,
      !finalEmail,
      emailToken,
      emailToken ? new Date(Date.now() + 86400000) : null
    ]);

    if (verificationToken) await kv.del(`valid:${verificationToken}`);

    res.json(successResponse({
      message: finalEmail ? '注册成功，已发送激活邮件' : '注册成功，请登录'
    }));

  } catch (e) {
    logger.error('注册失败', e);
    res.status(500).json(errorResponse('signup_fail', 500, (e as Error).message));
  }
});

// ==========================
// 登录 /login
// ==========================
router.post("/login", async (req: Request, res: Response) => {
  const logger = new Logger(req);
  try {
    const { username, password, verificationToken } = req.body;
    let user: User | null = null;

    if (verificationToken) {
      const valid = await kv.get<VerifyCacheItem>(`valid:${verificationToken}`);
      if (!valid)
        return res
          .status(400)
          .json(errorResponse("invalid_token", 400, "凭证无效"));
      // 字段白名单，防止SQL注入
      const colMap: Record<string, string> = { phone: "phone", email: "email" };
      const col = colMap[valid.contactType];
      const [rows] = await pool.query(`SELECT * FROM users WHERE ${col} = ?`, [
        valid.contactVal,
      ]);
      const arr = rows as User[];
      user = arr[0] ?? null;
    } else {
      const [rows] = await pool.query(
        "SELECT * FROM users WHERE username = ?",
        [username],
      );
      const arr = rows as User[];
      const u = arr[0];
      if (
        !u ||
        !password ||
        !u.password ||
        !bcrypt.compareSync(password, u.password)
      ) {
        return res
          .status(400)
          .json(errorResponse("auth_fail", 400, "账号或密码错误"));
      }
      user = u;
    }

    if (!user)
      return res
        .status(404)
        .json(errorResponse("not_found", 404, "用户不存在"));
    if (user.email && !user.email_verified)
      return res
        .status(403)
        .json(errorResponse("email_not_verify", 403, "请先激活邮箱"));

    await pool.query("UPDATE users SET last_login = NOW() WHERE user_id = ?", [
      user.user_id,
    ]);
    await kv.set(`user:info:${user.user_id}`, user, 600);
    const tokens = await createTokens(user.user_id, logger);
    res.json(successResponse(snakeToCamel({ tokenType: "Bearer", ...tokens })));
  } catch (e) {
    logger.error("登录失败", e);
    res
      .status(500)
      .json(errorResponse("login_fail", 500, (e as Error).message));
  }
});

// ==========================
// 刷新Token /token
// ==========================
router.post("/token", async (req: Request, res: Response) => {
  const logger = new Logger(req);
  try {
    const { grantType, refreshToken } = req.body;
    if (grantType !== "refresh_token")
      return res
        .status(400)
        .json(errorResponse("unsupported", 400, "仅支持 refresh_token"));

    const rtData = await kv.get<RefreshTokenData>(`rt:${refreshToken}`);
    if (!rtData || rtData.revoked)
      return res
        .status(401)
        .json(errorResponse("invalid_rt", 401, "登录已过期，请重新登录"));

    // 作废旧刷新令牌
    await kv.set(
      `rt:${refreshToken}`,
      { ...rtData, revoked: true } satisfies RefreshTokenData,
      10,
    );
    await pool.query(
      "UPDATE refresh_tokens SET revoked = true WHERE token = ?",
      [refreshToken],
    );
    const tokens = await createTokens(rtData.userId, logger);
    res.json(successResponse(snakeToCamel({ tokenType: "Bearer", ...tokens })));
  } catch (e) {
    logger.error("刷新token失败", e);
    res
      .status(500)
      .json(errorResponse("token_fail", 500, (e as Error).message));
  }
});

// ==========================
// 获取用户信息 /user/info
// ==========================
router.get(
  "/user/info",
  authMiddleware,
  async (req: Request, res: Response) => {
    const logger = new Logger(req);
    const userId = (req as any).user.sub as string;
    try {
      let user = await kv.get<User>(`user:info:${userId}`);
      if (!user) {
        const [rows] = await pool.query(
          "SELECT * FROM users WHERE user_id = ?",
          [userId],
        );
        const arr = rows as User[];
        user = arr[0];
        if (user) await kv.set(`user:info:${userId}`, user, 600);
      }
      if (!user)
        return res
          .status(404)
          .json(errorResponse("not_found", 404, "用户不存在"));

      const resData = snakeToCamel({
        userId: user.user_id,
        username: user.username,
        nickname: user.nickname,
        email: user.email,
        phone: user.phone,
        gender: user.gender,
        avatarUrl: user.avatar_url,
        hasPassword: user.has_password,
        emailVerified: user.email_verified,
      });
      res.json(successResponse(resData));
    } catch (e) {
      logger.error("获取信息失败", e);
      res.status(500).json(errorResponse("error", 500, (e as Error).message));
    }
  },
);

// ==========================
// 修改用户资料 /user/update
// ==========================
router.post(
  "/user/update",
  authMiddleware,
  async (req: Request, res: Response) => {
    const logger = new Logger(req);
    const userId = (req as any).user.sub as string;
    try {
      const { username, nickname, email, phone, avatar_url, gender } = req.body;
      // 字段白名单，禁止修改 password、email_verified 等敏感字段
      const updateFields: string[] = [];
      const updateParams: any[] = [];
      if (username !== undefined) {
        updateFields.push("username = ?");
        updateParams.push(username);
      }
      if (nickname !== undefined) {
        updateFields.push("nickname = ?");
        updateParams.push(nickname);
      }
      if (email !== undefined) {
        updateFields.push("email = ?");
        updateParams.push(email);
      }
      if (phone !== undefined) {
        updateFields.push("phone = ?");
        updateParams.push(phone);
      }
      if (avatar_url !== undefined) {
        updateFields.push("avatar_url = ?");
        updateParams.push(avatar_url);
      }
      if (gender !== undefined) {
        updateFields.push("gender = ?");
        updateParams.push(gender);
      }
      if (updateFields.length === 0) {
        return res
          .status(400)
          .json(errorResponse("empty_update", 400, "无更新字段"));
      }
      updateFields.push("updated_at = NOW()");
      updateParams.push(userId);

      await pool.query(
        `UPDATE users SET ${updateFields.join(", ")} WHERE user_id = ?`,
        updateParams,
      );
      // 清除用户缓存
      await kv.del(`user:info:${userId}`);
      res.json(successResponse(null));
    } catch (e) {
      logger.error("更新失败", e);
      res
        .status(500)
        .json(errorResponse("update_fail", 500, (e as Error).message));
    }
  },
);

// ==========================
// 登出 /logout
// ==========================
router.post(
  "/logout",
  authMiddleware,
  async (req: Request, res: Response) => {
    const logger = new Logger(req);
    const userId = (req as any).user.sub as string;
    try {
      // 批量作废该用户全部刷新令牌，支持多端下线
      const rtList = (await kv.get<string[]>(`user:rt:${userId}`)) ?? [];
      for (const rt of rtList) {
        await kv.set(
          `rt:${rt}`,
          { userId, revoked: true } satisfies RefreshTokenData,
          10,
        );
      }
      await kv.del(`user:rt:${userId}`);
      await kv.del(`user:info:${userId}`);
      await pool.query(
        "UPDATE refresh_tokens SET revoked = true WHERE user_id = ?",
        [userId],
      );
      res.json(successResponse({ message: "登出成功" }));
    } catch (e) {
      logger.error("登出失败", e);
      res
        .status(500)
        .json(errorResponse("logout_fail", 500, (e as Error).message));
    }
  },
);

// ==========================
// 图形验证码 /captcha
// ==========================
router.get("/captcha", async (req: Request, res: Response) => {
  try {
    const cap = createCaptcha();
    const captchaText = cap.text.toLowerCase();
    const id = uuidv4();
    await kv.set(`captcha:${id}`, captchaText, 180);
    res.setHeader("X-Captcha-Id", id);
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(cap.data);
  } catch (e) {
    const logger = new Logger(req);
    logger.error("生成图形验证码失败", e);
    res.status(500).json(errorResponse("captcha_err", 500, "验证码生成失败"));
  }
});
// ==========================
// 独立图形验证码校验接口 /captcha/verify
// ==========================
router.post("/captcha/verify", async (req: Request, res: Response) => {
  const logger = new Logger(req);
  try {
    const { captchaId, captcha } = req.body;
    if (!captchaId || !captcha) {
      return res
        .status(400)
        .json(errorResponse("invalid_param", 400, "验证码ID和验证码不能为空"));
    }
    const cacheKey = `captcha:${captchaId}`;
    const realCode = await kv.get<string>(cacheKey);
    if (!realCode) {
      return res
        .status(400)
        .json(errorResponse("captcha_expire", 400, "验证码已过期，请刷新"));
    }
    if (realCode !== captcha.toLowerCase()) {
      return res
        .status(400)
        .json(errorResponse("captcha_err", 400, "验证码错误"));
    }
    // 校验通过，删除缓存，一次性使用
    await kv.del(cacheKey);
    res.json(successResponse("验证码验证通过"));
  } catch (e) {
    logger.error("图形验证码校验失败", e);
    res
      .status(500)
      .json(errorResponse("server_error", 500, (e as Error).message));
  }
});
// ==========================
// 发送邮箱验证码 /email/send
// ==========================
router.post("/email/send", async (req: Request, res: Response) => {
  const logger = new Logger(req);
  try {
    const { email, captchaId, captcha } = req.body;
    const realCode = await kv.get<string>(`captcha:${captchaId}`);
    if (!realCode || realCode !== captcha.toLowerCase()) {
      return res
        .status(400)
        .json(errorResponse("captcha_err", 400, "图形验证码错误"));
    }
    await kv.del(`captcha:${captchaId}`);
    const code = generateCode();
    const vid = uuidv4();
    await kv.set(
      `email:${vid}`,
      {
        contactType: "email",
        contactVal: email,
        code,
      } satisfies VerifyCacheItem,
      300,
    );
    await sendCodeEmail(email, code, logger);
    res.json(successResponse({ verificationId: vid }));
  } catch (e) {
    logger.error("发送邮箱验证码失败", e);
    res.status(500).json(errorResponse("send_fail", 500, (e as Error).message));
  }
});

// ==========================
// 邮箱验证码校验 /email/verify
// ==========================
router.post("/email/verify", async (req: Request, res: Response) => {
  const logger = new Logger(req);
  try {
    const { verificationId, verificationCode } = req.body;
    const data = await kv.get<VerifyCacheItem>(`email:${verificationId}`);
    if (!data || data.code !== verificationCode) {
      return res.status(400).json(errorResponse("code_err", 400, "验证码错误"));
    }
    const token = crypto.randomBytes(20).toString("hex");
    await kv.set(`valid:${token}`, data, 600);
    await kv.del(`email:${verificationId}`);
    res.json(successResponse({ verificationToken: token }));
  } catch (e) {
    logger.error("邮箱验证失败", e);
    res
      .status(500)
      .json(errorResponse("verify_err", 500, (e as Error).message));
  }
});

// ==========================
// 邮箱激活链接访问 /email/verify
// ==========================
router.get("/email/verify", async (req: Request, res: Response) => {
  const logger = new Logger(req);
  try {
    const { token } = req.query;
    const email = await kv.get<string>(`activate:${token as string}`);
    if (!email)
      return res
        .status(400)
        .json(errorResponse("expired", 400, "激活链接已过期或无效"));

    await pool.query(
      `
      UPDATE users 
      SET email_verified = true, email_verify_token = null, email_verify_expires_at = null, updated_at = NOW() 
      WHERE email = ?
    `,
      [email],
    );
    await kv.del(`activate:${token as string}`);
    res.json(successResponse({ message: "邮箱激活成功" }));
  } catch (e) {
    logger.error("激活失败", e);
    res
      .status(500)
      .json(errorResponse("active_fail", 500, (e as Error).message));
  }
});

export default router;
