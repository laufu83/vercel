import { Router, Request, Response, NextFunction } from "express";
import { errorResponse, successResponse, authMiddleware } from "../middleware";

const router = Router();
const bucketName = "movies";

// 提取 Content-Type
function getContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    txt: "text/plain; charset=utf-8",
    json: "application/json; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    zip: "application/zip",
  };
  return map[ext] || "application/octet-stream";
}

function decodeFileName(name: string): string {
  try {
    return name.trim();
  } catch {
    return name;
  }
}

// 全局鉴权：所有文件接口需要登录
router.use(authMiddleware);

/// 1. POST /api/s3/upload 文件上传
router.post("/api/s3/upload", async (req: Request, res: Response) => {
  try {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json(errorResponse("env_miss", 500, "缺失 Supabase 环境变量"));
    }

    const filenameFromQuery = req.query.filename as string | undefined;
    const contentType = req.headers["content-type"] || "";
    const isFormData = contentType.includes("multipart/form-data");

    let finalFilename = `upload-${Date.now()}`;
    let fileType = "application/octet-stream";

    if (isFormData) {
      return res.status(400).json(errorResponse("form_not_support", 400, "请使用二进制上传，不支持 form-data"));
    }

    // ✅【正确写法】直接把 req.body 转成 ArrayBuffer（兼容 Netlify + Node）
    const arrayBuffer = req.body instanceof Buffer 
      ? req.body.buffer 
      : (req.body as ArrayBuffer);

    finalFilename = filenameFromQuery || finalFilename;
    fileType = getContentType(finalFilename);

    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${bucketName}/${finalFilename}`;

    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        "x-upsert": "true",
        "Content-Type": fileType,
      },
      body: arrayBuffer, // ✅ 只有 ArrayBuffer 100% 不报错
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      return res.status(400).json(errorResponse("upload_fail", 400, `上传失败：${errText}`));
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${bucketName}/${finalFilename}`;
    return res.json(successResponse({
      filename: finalFilename,
      contentType: fileType,
      downloadUrl: publicUrl,
    }));

  } catch (err: any) {
    return res.status(500).json(errorResponse("server_err", 500, err.message));
  }
});

// 2. GET /api/s3/text/:filename 读取文本文件
router.get("/api/s3/text/:filename", async (req: Request, res: Response) => {
  try {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    const { filename } = req.params;
    const fileUrl = `${SUPABASE_URL}/storage/v1/object/${bucketName}/${filename}`;

    const fetchRes = await fetch(fileUrl, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY! },
    });
    if (!fetchRes.ok) {
      return res.status(404).json(errorResponse("not_found", 404, "文件不存在或读取失败"));
    }
    const text = await fetchRes.text();
    return res.json(successResponse(text));
  } catch (err: any) {
    return res.status(500).json(errorResponse("read_err", 500, err.message));
  }
});

// 3. GET /api/s3/download/:filename 文件预览/下载
router.get("/api/s3/download/:filename", async (req: Request, res: Response) => {
  try {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    const { filename } = req.params;
    const download = req.query.download;
    const isDownload = download === "true" || download === "1";

    const fileUrl = `${SUPABASE_URL}/storage/v1/object/${bucketName}/${filename}`;
    const fetchRes = await fetch(fileUrl, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY!}`,
      },
    });

    if (!fetchRes.ok) {
      return res.status(404).send("File not found");
    }

    const contentType = fetchRes.headers.get("Content-Type") || getContentType(filename);
    res.setHeader("Content-Type", contentType);
    if (isDownload) {
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    }

    // 流式返回文件流
    const arrayBuf = await fetchRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    return res.end(buffer);
  } catch (err: any) {
    return res.status(500).send("Server Error");
  }
});

// 4. DELETE /api/s3/delete/:filename 删除文件
router.delete("/api/s3/delete/:filename", async (req: Request, res: Response) => {
  try {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    const { filename } = req.params;
    const deleteUrl = `${SUPABASE_URL}/storage/v1/object/${bucketName}/${filename}`;

    const fetchRes = await fetch(deleteUrl, {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY!}`,
      },
    });

    if (!fetchRes.ok) {
      const errText = await fetchRes.text();
      return res.status(400).json(errorResponse("delete_fail", 400, `删除失败: ${errText}`));
    }
    return res.json(successResponse("文件删除成功"));
  } catch (err: any) {
    return res.status(500).json(errorResponse("server_err", 500, err.message));
  }
});

export default router;