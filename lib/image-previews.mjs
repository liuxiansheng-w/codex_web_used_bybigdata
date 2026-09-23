import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const limit = 10 * 1024 * 1024;
const fail = (message, status = 404) => { throw Object.assign(new Error(message), { status }); };
function imageType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  fail('此附件不是可预览的 PNG、JPEG、GIF 或 WebP 图片。', 415);
}

// Only server-registered attachments/native image items create entries. HTTP
// clients receive opaque IDs, never a general-purpose local file read route.
export class ImagePreviews {
  entries = new Map();
  sources = new Map();
  dataBytes = 0;

  describe(input, name = '') {
    const label = path.basename(String(name || input.name || (input.type === 'localImage' ? input.path : '') || '图片').replaceAll('\\', '/'));
    const unavailable = { kind: 'image', name: label, unavailable: true };
    const source = input.type === 'localImage' ? input.path : input.type === 'image' ? input.url : null;
    if (typeof source !== 'string') return unavailable;
    const local = input.type === 'localImage';
    if (local && (!path.isAbsolute(source) || source.length > 4096 || source.includes('\0'))) return unavailable;
    // Never fetch remote URLs or permit executable SVG/HTML through this route.
    if (!local && (source.length > 14_000_000 || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(source))) return unavailable;
    const key = createHash('sha256').update(`${local ? 'path' : 'data'}:${source}`).digest('hex');
    let id = this.sources.get(key);
    if (!id) {
      if (this.entries.size >= 5000 || (!local && this.dataBytes + source.length > 100 * 1024 * 1024)) return unavailable;
      id = randomUUID();
      this.entries.set(id, { local, source, name: label }); this.sources.set(key, id);
      if (!local) this.dataBytes += source.length;
    }
    return { kind: 'image', name: label, previewUrl: `/api/attachments/images/${id}` };
  }

  async read(id) {
    const entry = this.entries.get(id);
    if (!entry) fail('图片预览已过期，请重新打开会话。');
    let bytes, handle;
    try {
      if (!entry.local) bytes = Buffer.from(entry.source.slice(entry.source.indexOf(',') + 1), 'base64');
      else {
        const resolved = await realpath(entry.source);
        handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = await handle.stat();
        if (!info.isFile()) fail('图片源文件不可用。');
        if (info.size > limit) fail('图片超过 10 MB，无法预览。', 413);
        // Bound the read even if a referenced file grows after stat().
        const buffer = Buffer.alloc(limit + 1); let size = 0;
        while (size < buffer.length) {
          const result = await handle.read(buffer, size, buffer.length - size, size);
          if (!result.bytesRead) break;
          size += result.bytesRead;
        }
        bytes = buffer.subarray(0, size);
      }
      if (bytes.length > limit) fail('图片超过 10 MB，无法预览。', 413);
      return { bytes, contentType: imageType(bytes), name: entry.name };
    } catch (error) {
      if (error.status) throw error;
      fail('图片源文件已失效或无法读取。');
    } finally { await handle?.close(); }
  }
}

export function userMessageContent(content = [], images) {
  const localPaths = new Set(content.filter(item => item.type === 'localImage').map(item => item.path));
  const names = new Map();
  const jsonString = '"(?:[^"\\\\\\r\\n]|\\\\.)*"';
  const wrapper = new RegExp(`(^|\\n)用户附加的文件：(${jsonString})\\r?\\n本机路径：(${jsonString})(?=\\r?\\n|$)`, 'g');
  const texts = content.filter(item => item.type === 'text').map(item => String(item.text || '').replace(wrapper, (block, _prefix, encodedName, encodedPath) => {
    try {
      const filename = JSON.parse(encodedPath);
      if (localPaths.has(filename)) { names.set(filename, JSON.parse(encodedName)); return ''; }
    } catch { /* Preserve anything that is not our exact generated wrapper. */ }
    return block;
  })).filter(Boolean);
  const attachments = content.filter(item => ['localImage', 'image', 'skill', 'mention'].includes(item.type)).map(item => {
    if (item.type === 'localImage' || item.type === 'image') return images.describe(item, names.get(item.path));
    return { kind: item.type, name: item.name || (item.path ? path.basename(item.path) : '附件') };
  });
  return { text: texts.join('\n') || (attachments.length ? '' : '[非文本消息]'), attachments };
}
