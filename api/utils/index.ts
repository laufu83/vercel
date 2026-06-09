import crypto from "crypto";
interface CaptchaResult {
  text: string;
  data: string;
}
export function snakeToCamel(obj: any): any {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(snakeToCamel);
  return Object.entries(obj).reduce((acc, [k, v]) => {
    const key = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    acc[key] = snakeToCamel(v);
    return acc;
  }, {} as any);
}

export function strCut(str: any, len = 1000) {
  if (!str) return '';
  return String(str).slice(0, len);
}

export function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// export function createCaptcha() {
//   const text = Math.random().toString(36).slice(2,6).toUpperCase();
//   return {
//     text,
//     data: `<svg width="80" height="30"><text x="10" y="20">${text}</text></svg>`
//   };
// }


export function createCaptcha(): CaptchaResult {
  // 验证码字符池，去掉易混淆字符
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  // 生成4位验证码
  for (let i = 0; i < 4; i++) {
    code += chars[crypto.randomInt(0, chars.length)];
  }

  const width = 120;
  const height = 40;
  const svgParts: string[] = [];

  // 1. 背景浅底色
  svgParts.push(`<rect width="${width}" height="${height}" fill="#f6f6f6"/>`);

  // 2. 绘制多条干扰线
  const lineCount = 4;
  for (let i = 0; i < lineCount; i++) {
    const x1 = crypto.randomInt(0, width);
    const y1 = crypto.randomInt(0, height);
    const x2 = crypto.randomInt(0, width);
    const y2 = crypto.randomInt(0, height);
    const stroke = ["#999", "#aaa", "#bbb", "#ccc"][crypto.randomInt(0, 4)];
    const w = crypto.randomInt(1, 2);
    svgParts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${w}"/>`);
  }

  // 3. 随机噪点小点
  const dotCount = 30;
  for (let i = 0; i < dotCount; i++) {
    const x = crypto.randomInt(0, width);
    const y = crypto.randomInt(0, height);
    const r = crypto.randomInt(1, 2);
    const fill = ["#777", "#888", "#999"][crypto.randomInt(0, 3)];
    svgParts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`);
  }

  // 4. 逐个绘制文字，随机偏移、旋转、颜色
  const colorList = ["#222", "#333", "#444", "#555"];
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    const x = 15 + i * 24 + crypto.randomInt(-4, 4);
    const y = 26 + crypto.randomInt(-5, 5);
    const rotate = crypto.randomInt(-20, 20);
    const fill = colorList[crypto.randomInt(0, colorList.length)];
    const fontSize = crypto.randomInt(20, 26);
    svgParts.push(`
      <text 
        x="${x}" 
        y="${y}" 
        fill="${fill}" 
        font-size="${fontSize}" 
        font-family="Arial"
        transform="rotate(${rotate} ${x} ${y})"
      >${char}</text>
    `);
  }

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      ${svgParts.join("")}
    </svg>
  `.trim();

  return {
    text: code.toLowerCase(),
    data: svg
  };
}
export function getSafeTable(table?: string) {
  return table?.replace(/[^a-zA-Z0-9_]/g, '') || 'vod_dytt';
}
export * from './logger';