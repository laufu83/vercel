import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../middleware';
import { kv } from '../redis';
import { Logger } from '../utils';

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const logger = new Logger(req);
  logger.info('【鉴权中间件】开始校验登录状态');

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('【鉴权失败】未提供 Token');
      return res.status(401).json(errorResponse('unauthorized', 401, '请先登录'));
    }

    const token = authHeader.split(' ')[1];

    // ==============================
    // ✅【核心修复】用 accessToken 查，不是 rt:
    // ==============================
    const redisKey = `at:${token}`;
    logger.redis('GET', redisKey);

    const userData = await kv.get(redisKey);
    if (!userData) {
      logger.warn('【鉴权失败】AccessToken 无效或已过期', { token: token.slice(0, 10) });
      return res.status(401).json(errorResponse('invalid_token', 401, '登录已过期，请重新登录'));
    }

    
    // ✅ 正确挂载用户信息
    (req as any).user = { sub: (userData as any).userId };
    logger.info('【鉴权成功】用户ID：' + (userData as any).userId);
    next();

  } catch (err) {
    logger.error('【鉴权异常】', err);
    res.status(401).json(errorResponse('auth_error', 401, '登录状态校验失败'));
  }
}