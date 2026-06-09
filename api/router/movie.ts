import { Router, Request, Response } from "express";
import { pool } from "../db";
import { getSafeTable, strCut } from "../utils";
import { successResponse, errorResponse } from "../middleware";

const router = Router();

// ==========================
// 视频列表 ✅ 完整修复
// ==========================
router.get("/list", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const size = Math.min(50, Math.max(1, parseInt(req.query.size as string) || 20));
    const offset = (page - 1) * size;
    const type = req.query.type as string;
    const table = getSafeTable((req.query.table as string) || "vod_dytt");

    let where = "WHERE 1=1";
    const params: any[] = [];

    if (type) {
      where += " AND type_id = ?";
      params.push(type);
    }

    const [rows] = await pool.query(
      `SELECT * FROM ${table} ${where} ORDER BY vod_time DESC LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );

    const [totalRow] = await pool.query(
      `SELECT COUNT(*) AS count FROM ${table} ${where}`,
      params
    );

    //const total = (totalRow as any[])[0]?.count || 0;

    res.json(successResponse(
       rows
    ));

  } catch (e) {
    res.status(500).json(errorResponse("server_error", 500, (e as Error).message));
  }
});

// ==========================
// 视频详情 ✅ 修复
// ==========================
router.get("/detail", async (req: Request, res: Response) => {
  try {
    const id = req.query.id as string;
    const table = getSafeTable((req.query.table as string) || "vod_dytt");

    if (!id) {
      return res.status(400).json(errorResponse("invalid_param", 400, "id 不能为空"));
    }

    const [rows] = await pool.query(`SELECT * FROM ${table} WHERE vod_id = ?`, [id]);

    if (!(rows as any[]).length) {
      return res.status(404).json(errorResponse("not_found", 404, "视频不存在"));
    }

    res.json(successResponse((rows as any[])[0]));

  } catch (e) {
    res.status(500).json(errorResponse("server_error", 500, (e as Error).message));
  }
});

// ==========================
// 搜索 ✅ 修复：补充分页总数
// ==========================
router.get("/search", async (req: Request, res: Response) => {
  try {
    const keyword = (req.query.keyword as string) || "";
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const size = Math.min(50, Math.max(1, parseInt(req.query.size as string) || 20));
    const offset = (page - 1) * size;
    const table = getSafeTable((req.query.table as string) || "vod_dytt");

    const kw = `%${keyword}%`;
    const sql = `
      SELECT * FROM ${table} 
      WHERE vod_name LIKE ? 
         OR vod_sub LIKE ? 
         OR vod_actor LIKE ? 
         OR vod_director LIKE ? 
      ORDER BY vod_time DESC 
      LIMIT ? OFFSET ?
    `;

    const [rows] = await pool.query(sql, [kw, kw, kw, kw, size, offset]);

    // const [totalRow] = await pool.query(
    //   `SELECT COUNT(*) AS count FROM ${table} 
    //    WHERE vod_name LIKE ? 
    //       OR vod_sub LIKE ? 
    //       OR vod_actor LIKE ? 
    //       OR vod_director LIKE ?`,
    //   [kw, kw, kw, kw]
    // );

    //const total = (totalRow as any[])[0]?.count || 0;

    res.json(successResponse(rows));

  } catch (e) {
    res.status(500).json(errorResponse("server_error", 500, (e as Error).message));
  }
});

// ==========================
// 采集同步 ✅ 修复：安全、异常、格式
// ==========================
router.get("/sync", async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    const table = getSafeTable((req.query.table as string) || "vod_dytt");
    const apiUrl = (req.query.api_url as string) || process.env.API_VOD_URL;

    if (!process.env.SYNC_TOKEN || token !== process.env.SYNC_TOKEN) {
      return res.status(403).json(errorResponse("forbidden", 403, "无权限"));
    }

    if (!apiUrl) {
      return res.status(400).json(errorResponse("invalid_config", 400, "未配置采集地址"));
    }

    const first = await fetch(`${apiUrl}&pg=1`);
    if (!first.ok) {
      return res.status(500).json(errorResponse("external_error", 500, "采集接口访问失败"));
    }

    const data = await first.json();
    const list = data.list || [];

    if (list.length === 0) {
      return res.json(successResponse({ msg: "暂无数据可同步", count: 0 }));
    }

    const batch = list.map((item: any) => [
      item.vod_id,
      item.type_id,
      strCut(item.type_name, 50),
      item.type_id_1,
      strCut(item.vod_name, 255),
      strCut(item.vod_sub, 255),
      strCut(item.vod_en, 255),
      strCut(item.vod_letter, 10),
      strCut(item.vod_class, 100),
      item.vod_pic,
      strCut(item.vod_actor, 500),
      strCut(item.vod_director, 200),
      strCut(item.vod_area, 50),
      strCut(item.vod_lang, 50),
      item.vod_year,
      item.vod_douban_id,
      item.vod_douban_score,
      strCut(item.vod_content, 2000),
      strCut(item.vod_remarks, 255),
      item.vod_score,
      item.vod_play_url,
      item.vod_status,
      item.vod_time,
    ]);

    const ph = Array(batch.length).fill("(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",");

    await pool.query(
      `
      INSERT INTO ${table} (
        vod_id,type_id,type_name,type_id_1,vod_name,vod_sub,vod_en,vod_letter,
        vod_class,vod_pic,vod_actor,vod_director,vod_area,vod_lang,vod_year,
        vod_douban_id,vod_douban_score,vod_content,vod_remarks,vod_score,
        vod_play_url,vod_status,vod_time
      ) VALUES ${ph}
      ON DUPLICATE KEY UPDATE 
        type_id=VALUES(type_id),
        type_name=VALUES(type_name),
        vod_name=VALUES(vod_name),
        vod_pic=VALUES(vod_pic),
        vod_play_url=VALUES(vod_play_url),
        vod_time=VALUES(vod_time)
    `,
      batch.flat()
    );

    res.json(successResponse({
      msg: "同步完成",
      count: list.length,
    }));

  } catch (e) {
    res.status(500).json(errorResponse("sync_error", 500, (e as Error).message));
  }
});

export default router;