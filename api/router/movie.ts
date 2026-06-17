import { Router, Request, Response } from "express";
import { pool } from "../db";
import { getSafeTable, strCut } from "../utils";
import { successResponse, errorResponse } from "../middleware";

const router = Router();

// ==========================
// 视频列表 ✅ 完整修复  &year=${year}&area=${area}&lang=${lang}&class=${class}
// ==========================
router.get("/list", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const size = Math.min(50, Math.max(1, parseInt(req.query.size as string) || 20));
    const offset = (page - 1) * size;
    const type = req.query.type as string;
    const year = req.query.year as string;
    const area = req.query.area as string;
    const lang = req.query.lang as string;
    const clazz = req.query.class as string;
    const letter = req.query.letter as string;
    const table = getSafeTable((req.query.table as string) || "vod_dytt");

    let where = "WHERE 1=1";
    const params: any[] = [];

    if (type) {
      where += " AND type_id = ?";
      params.push(type);
    }
    if (year) {
      where += " AND vod_year = ?";
      params.push(year);
    }
    if (area) {
      where += " AND vod_area = ?";
      params.push(area);
    }
    if (lang) {
      where += " AND vod_lang = ?";
      params.push(lang);
    }
    if (clazz) {
      where += " AND vod_class like ?";
      params.push(`%${clazz}%`);
    }
    if (letter) {
      where += " AND vod_letter = ?";
      params.push(letter);
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
// 采集同步 ✅ 自动分页 + 详细日志 + 异常处理
// ==========================
router.get("/sync", async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    const table = getSafeTable((req.query.table as string) || "vod_dytt");
    const apiUrl = (req.query.api_url as string) || process.env.API_VOD_URL;

    // 日志记录
    const startTime = Date.now();
    const log: string[] = [];
    log.push(`[启动] 表：${table}`);
    log.push(`[接口] ${apiUrl}`);

    // 权限校验
    if (!process.env.SYNC_TOKEN || token !== process.env.SYNC_TOKEN) {
      log.push(`[错误] 无权限，token：${token}`);
      console.log(log.join("\n"));
      return res.status(403).json(errorResponse("forbidden", 403, "无权限"));
    }

    if (!apiUrl) {
      log.push("[错误] 未配置采集接口地址");
      console.log(log.join("\n"));
      return res.status(400).json(errorResponse("invalid_config", 400, "未配置采集地址"));
    }

    // =========================================
    // 1. 请求第 1 页，获取总页数
    // =========================================
    log.push(`[请求] 第 1 页`);
    const firstPageRes = await fetch(`${apiUrl}&pg=1`);
    if (!firstPageRes.ok) {
      log.push(`[错误] 第 1 页请求失败，状态码：${firstPageRes.status}`);
      console.log(log.join("\n"));
      return res.status(500).json(errorResponse("external_error", 500, "采集接口访问失败"));
    }

    const firstPageData = await firstPageRes.json();
    const totalPage = Number(firstPageData.totalPage || firstPageData.pagecount || 1);
    const firstList = firstPageData.list || [];

    log.push(`[分页] 第 1 页返回 ${firstList.length} 条`);
    log.push(`[分页] 总页数：${totalPage}`);

    if (firstList.length === 0) {
      log.push("[结束] 无数据可同步");
      console.log(log.join("\n"));
      return res.json(successResponse({ msg: "暂无数据可同步", count: 0, log }));
    }

    // =========================================
    // 2. 批量入库
    // =========================================
    let totalCount = 0;
    const pageSuccess: number[] = [];
    const pageFail: number[] = [];

    // 处理第 1 页
    try {
      await batchInsert(table, firstList.map(createVodRow));
      totalCount += firstList.length;
      pageSuccess.push(1);
      log.push(`[入库] 第 1 页 → 成功 ${firstList.length} 条`);
    } catch (e) {
      pageFail.push(1);
      log.push(`[入库] 第 1 页 → 失败：${(e as Error).message}`);
    }

    // =========================================
    // 3. 自动同步 2 ~ totalPage
    // =========================================
    log.push(`[批量] 开始同步 2 ~ ${totalPage} 页`);

    for (let pg = 2; pg <= totalPage; pg++) {
      try {
        const url = `${apiUrl}&pg=${pg}`;
        const resp = await fetch(url);
        const data = await resp.json();
        const list = data.list || [];

        if (list.length === 0) {
          log.push(`[空页] 第 ${pg} 页`);
          continue;
        }

        await batchInsert(table, list.map(createVodRow));
        totalCount += list.length;
        pageSuccess.push(pg);
        log.push(`[入库] 第 ${pg} 页 → 成功 ${list.length} 条`);
      } catch (err) {
        pageFail.push(pg);
        log.push(`[失败] 第 ${pg} 页 → ${(err as Error).message}`);
      }
    }

    // =========================================
    // 最终统计
    // =========================================
    const useTime = ((Date.now() - startTime) / 1000).toFixed(2);
    log.push(`\n[完成] 耗时：${useTime}s`);
    log.push(`[完成] 总条数：${totalCount}`);
    log.push(`[完成] 成功页：${pageSuccess.join(",")}`);
    if (pageFail.length) log.push(`[完成] 失败页：${pageFail.join(",")}`);

    // 输出日志
    console.log("\n" + "=".repeat(60));
    console.log(log.join("\n"));
    console.log("=".repeat(60) + "\n");

    // 返回
    res.json(successResponse({
      msg: "同步完成",
      totalPage,
      totalCount,
      successPages: pageSuccess,
      failPages: pageFail,
      useTime: `${useTime}s`,
      log
    }));

  } catch (e) {
    const errMsg = (e as Error).message;
    console.log("[同步异常]", errMsg);
    res.status(500).json(errorResponse("sync_error", 500, errMsg));
  }
});

// ==========================
// 工具：生成单条数据
// ==========================
function createVodRow(item: any) {
  return [
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
  ];
}

// ==========================
// 工具：批量插入 DB
// ==========================
async function batchInsert(table: string, rows: any[][]) {
  if (rows.length === 0) return;

  const ph = rows.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
  const values = rows.flat();

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
    values
  );
}

export default router;