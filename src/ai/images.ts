/** 图片输入的上限：避免把浏览器里的超大原图直接塞进请求体。 */
export const IMAGE_LIMITS = {
  files: 4,
  fileBytes: 6 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
} as const;

export interface AiImage {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  dataUrl: string;
}

export interface ImageReadResult {
  images: AiImage[];
  skipped: { name: string; reason: string }[];
}

let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `image-${Date.now()}-${sequence}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** 将用户选中的图片转成 OpenAI 兼容接口能识别的 data URL。 */
export async function readImageFiles(input: FileList | File[]): Promise<ImageReadResult> {
  const images: AiImage[] = [];
  const skipped: ImageReadResult["skipped"] = [];
  let totalBytes = 0;

  for (const file of Array.from(input)) {
    if (!file.type.startsWith("image/")) {
      skipped.push({ name: file.name || "未命名文件", reason: "只支持图片文件" });
      continue;
    }
    if (images.length >= IMAGE_LIMITS.files) {
      skipped.push({ name: file.name || "未命名图片", reason: `最多添加 ${IMAGE_LIMITS.files} 张图片` });
      continue;
    }
    if (file.size > IMAGE_LIMITS.fileBytes) {
      skipped.push({ name: file.name || "未命名图片", reason: "单张图片超过 6MB" });
      continue;
    }
    if (totalBytes + file.size > IMAGE_LIMITS.totalBytes) {
      skipped.push({ name: file.name || "未命名图片", reason: "图片总大小超过 16MB" });
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      images.push({
        id: nextId(),
        name: file.name || "粘贴的图片",
        mimeType: file.type || "image/png",
        bytes: file.size,
        dataUrl: `data:${file.type || "image/png"};base64,${toBase64(bytes)}`,
      });
      totalBytes += file.size;
    } catch (error) {
      skipped.push({ name: file.name || "未命名图片", reason: error instanceof Error ? error.message : "读取失败" });
    }
  }
  return { images, skipped };
}

export function totalImageBytes(images: AiImage[]): number {
  return images.reduce((sum, image) => sum + image.bytes, 0);
}
