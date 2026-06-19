import { Router, Request, Response } from "express";
import { pool } from "../db";
import { getSafeTable, strCut } from "../utils";
import { successResponse, errorResponse } from "../middleware";
import { pinyin } from "pinyin-pro";
const router = Router();
// 拼音配置
const MAX_LENGTH = 50;
/**
 * 根据片名生成大写拼音首字母，仅保留A-Z，无缓存
 */
function getFirstLetter(str: string): string {
  const trimStr = str?.trim();
  if (!trimStr) return '';

  try {
    // type:string 固定返回字符串，无需判断数组
    const lettersRaw = pinyin(trimStr, {
      pattern: 'first',
      type: 'string',
      toneType: 'none'
    }).toUpperCase();

    // 仅保留大写A-Z + 数字0-9
    let letters = lettersRaw.replace(/[^A-Z0-9]/g, '');

    // 拼音解析为空（英文/数字/符号），取第一个字符大写兜底
    if (!letters) {
      const firstChar = trimStr[0].toUpperCase();
      letters = /[A-Z0-9]/.test(firstChar) ? firstChar : '';
    }

    // 长度截断
    if (letters.length > MAX_LENGTH) {
      letters = letters.substring(0, MAX_LENGTH);
    }

    return letters;
  } catch {
    return '';
  }
}
// ==========================
// 视频列表 ✅ 完整修复
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

    res.json(successResponse(rows));

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
// 搜索 ✅ 修复
// ==========================
router.get("/search", async (req: Request, res: Response) => {
  try {
    const keyword = (req.query.keyword as string) || "";
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const size = Math.min(50, Math.max(1, parseInt(req.query.size as string) || 20));
    const offset = (page - 1) * size;
    const table = getSafeTable((req.query.table as string) || "vod_dytt");
    // 正则：仅大小写字母、数字
    const ENGLISH_NUM_REG = /^[A-Za-z0-9]+$/;
    // 场景1：纯英文/数字 → 拼音首字母前缀查询（走索引）
    if (ENGLISH_NUM_REG.test(keyword)) {
      const letterKw = `${keyword.toUpperCase()}%`;
      const sql = `
        SELECT vod_id,type_name,vod_name,vod_sub,vod_class,vod_pic,vod_actor,vod_director,
               vod_time,vod_area,vod_lang,vod_year,vod_douban_score,vod_remarks,
               vod_score,vod_content,vod_play_url
        FROM ${table}
        WHERE vod_name_letter LIKE ?
        ORDER BY vod_time DESC
        LIMIT ? OFFSET ?
      `;
      const [rows] = await pool.query(sql, [letterKw, size, offset]);
        res.json(successResponse(rows));
    }else{
      const kw = `%${keyword}%`; 
      const sql = `
        SELECT t1.vod_id,t1.type_name,t1.vod_name,t1.vod_sub,t1.vod_class,t1.vod_pic,
               t1.vod_actor,t1.vod_director,t1.vod_time,t1.vod_area,t1.vod_lang,t1.vod_year,
               t1.vod_douban_score,t1.vod_remarks,t1.vod_score,t1.vod_content,t1.vod_play_url
        FROM ${table} t1
        INNER JOIN (
            SELECT DISTINCT vod_id, vod_time
            FROM (          
                SELECT vod_id, vod_time FROM ${table} WHERE vod_name LIKE ?
                UNION ALL
                SELECT vod_id, vod_time FROM ${table} WHERE vod_sub LIKE ?
                UNION ALL
                SELECT vod_id, vod_time FROM ${table} WHERE vod_actor LIKE ?
                UNION ALL
                SELECT vod_id, vod_time FROM ${table} WHERE vod_director LIKE ?
            ) AS union_result
            ORDER BY vod_time DESC
            LIMIT ? OFFSET ?
        ) t2 ON t1.vod_id = t2.vod_id
        ORDER BY t1.vod_time DESC;
      `;
      const [rows] = await pool.query(sql, [kw, kw, kw, kw, size, offset]);
      res.json(successResponse(rows));
    }
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

    const startTime = Date.now();
    const log: string[] = [];
    log.push(`[启动] 表：${table}`);
    log.push(`[接口] ${apiUrl}`);

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

    let totalCount = 0;
    const pageSuccess: number[] = [];
    const pageFail: number[] = [];

    try {
      await batchInsert(table, firstList.map(createVodRow));
      totalCount += firstList.length;
      pageSuccess.push(1);
      log.push(`[入库] 第 1 页 → 成功 ${firstList.length} 条`);
    } catch (e) {
      pageFail.push(1);
      log.push(`[入库] 第 1 页 → 失败：${(e as Error).message}`);
    }

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

    const useTime = ((Date.now() - startTime) / 1000).toFixed(2);
    log.push(`\n[完成] 耗时：${useTime}s`);
    log.push(`[完成] 总条数：${totalCount}`);
    log.push(`[完成] 成功页：${pageSuccess.join(",")}`);
    if (pageFail.length) log.push(`[完成] 失败页：${pageFail.join(",")}`);

    console.log("\n" + "=".repeat(60));
    console.log(log.join("\n"));
    console.log("=".repeat(60) + "\n");

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
// 工具：生成单条数据（新增 vod_name_letter）
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
    // 新增：片名拼音首字母
    strCut(getFirstLetter(item.vod_name || ''), 50)
  ];
}

// ==========================
// 工具：批量插入 DB（字段+占位符同步新增）
// ==========================
async function batchInsert(table: string, rows: any[][]) {
  if (rows.length === 0) return;

  // 24个占位符
  const ph = rows.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
  const values = rows.flat();

  await pool.query(
    `
    INSERT INTO ${table} (
      vod_id,type_id,type_name,type_id_1,vod_name,vod_sub,vod_en,vod_letter,
      vod_class,vod_pic,vod_actor,vod_director,vod_area,vod_lang,vod_year,
      vod_douban_id,vod_douban_score,vod_content,vod_remarks,vod_score,
      vod_play_url,vod_status,vod_time,vod_name_letter
    ) VALUES ${ph}
    ON DUPLICATE KEY UPDATE 
      type_id=VALUES(type_id),
      type_name=VALUES(type_name),
      vod_name=VALUES(vod_name),
      vod_pic=VALUES(vod_pic),
      vod_play_url=VALUES(vod_play_url),
      vod_time=VALUES(vod_time),
      vod_name_letter=VALUES(vod_name_letter)
  `,
    values
  );
}

/**
 * 高性能批量刷新 vod_name_letter
 * 仅更新 vod_name_letter IS NULL 数据
 * 游标分页 + 批量事务 + 索引优化，每批200，单次上限2000
 */
router.get("/refresh", async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    const table = getSafeTable((req.query.table as string) || "vod_dytt");
    const BATCH_SIZE = 200;
    const MAX_TOTAL = 2000;

    const startTime = Date.now();
    const log: string[] = [];

    if (!process.env.SYNC_TOKEN || token !== process.env.SYNC_TOKEN) {
      log.push("[错误] 权限校验失败");
      console.log(log.join("\n"));
      return res.status(403).json(errorResponse("forbidden", 403, "无操作权限"));
    }

    log.push(`[开始刷新] 表：${table}，仅更新 vod_name_letter IS NULL`);
    log.push(`[性能策略] 主键游标分页 + 批量事务 + 索引优化，每批${BATCH_SIZE}条，上限${MAX_TOTAL}条`);

    let totalUpdated = 0;
    let lastVodId = 0;

    while (totalUpdated < MAX_TOTAL) {
      // 1. 强制走主键索引，只查两列，极小网络开销
      const [rows] = await pool.query(
        `SELECT vod_id, vod_name FROM ${table} USE INDEX(PRIMARY)
         WHERE vod_id > ? AND vod_name_letter IS NULL
         ORDER BY vod_id ASC LIMIT ?`,
        [lastVodId, BATCH_SIZE]
      );
      const list = rows as any[];
      if (list.length === 0) {
        log.push(`[结束] 无更多待刷新NULL数据`);
        break;
      }

      // 2. 构造批量CASE UPDATE
      let caseSql = `UPDATE ${table} SET vod_name_letter = CASE vod_id `;
      const params: any[] = [];
      const idList: string[] = [];

      for (const item of list) {
        const letter = strCut(getFirstLetter(item.vod_name || ""), 60);
        caseSql += `WHEN ? THEN ? `;
        params.push(item.vod_id, letter);
        idList.push("?");
      }
      caseSql += `END WHERE vod_id IN (${idList.join(",")})`;
      params.push(...list.map(i => i.vod_id));

      // 3. 单批事务包裹，大幅提升写入性能
      await pool.query("START TRANSACTION");
      await pool.query(caseSql, params);
      await pool.query("COMMIT");

      lastVodId = list[list.length - 1].vod_id;
      totalUpdated += list.length;
      log.push(`[批次成功] 本批${list.length}条，游标ID:${lastVodId}，累计${totalUpdated}条`);
    }

    const cost = ((Date.now() - startTime) / 1000).toFixed(2);
    log.push(`\n[刷新完成] 总更新：${totalUpdated} 条，耗时：${cost} s`);
    console.log("\n" + "=".repeat(60));
    console.log(log.join("\n"));
    console.log("=".repeat(60) + "\n");

    return res.json(successResponse({
      totalUpdated,
      batchSize: BATCH_SIZE,
      maxLimit: MAX_TOTAL,
      useTime: `${cost}s`,
      log
    }));

  } catch (err) {
    await pool.query("ROLLBACK"); // 异常回滚防止锁表
    const msg = (err as Error).message;
    console.error("刷新异常：", msg);
    return res.status(500).json(errorResponse("refresh_error", 500, msg));
  }
});

export default router;