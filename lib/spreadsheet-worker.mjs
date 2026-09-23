import { parentPort, workerData } from 'node:worker_threads';
import XLSX from 'xlsx';

// Bound ZIP expansion before handing XML to the spreadsheet parser. XLS binary
// files still run in this disposable worker with heap/time limits.
export function validateArchive(bytes) {
  if (bytes.readUInt32LE(0) !== 0x04034b50) return;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  if (end < 0) throw new Error('Excel 压缩包不完整。');
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12);
  if (count > 4096 || offset + size !== end || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('工作簿结构过大或不受支持。');
  let at = offset, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('工作簿结构无效。');
    expanded += bytes.readUInt32LE(at + 24);
    if (expanded > 32 * 1024 * 1024) throw new Error('工作簿解压后超过 32 MB，请下载查看。');
    at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  if (at !== end) throw new Error('工作簿目录无效。');
}
export function previewWorkbook(bytes, sheet = 0) {
  if (bytes.length < 8) throw new Error('工作簿为空或格式无效。');
  validateArchive(bytes);
  const names = XLSX.read(bytes, { type: 'buffer', bookSheets: true }).SheetNames;
  if (!names?.length || sheet >= names.length) throw new Error('工作表不存在。');
  const book = XLSX.read(bytes, { type: 'buffer', sheets: sheet, sheetRows: 2000, cellHTML: false, cellFormula: false, bookVBA: false });
  const table = book.Sheets[names[sheet]], range = XLSX.utils.decode_range(table?.['!fullref'] || table?.['!ref'] || 'A1');
  const endRow = Math.min(range.e.r + 1, 2000), endCol = Math.min(range.e.c + 1, 100), rows = [];
  let used = 0, limited = false;
  for (let r = 0; r < endRow; r++) {
    const row = [];
    for (let c = 0; c < endCol; c++) {
      const cell = table?.[XLSX.utils.encode_cell({ r, c })];
      const value = cell ? String(cell.w ?? XLSX.utils.format_cell(cell)) : '';
      const text = value.slice(0, 10000); limited ||= text.length !== value.length; used += Buffer.byteLength(text);
      row.push(text);
    }
    if (used > 2 * 1024 * 1024) { limited = true; break; }
    rows.push(row);
  }
  return { sheets: names.slice(0, 100), sheet, rows, columns: Array.from({ length: endCol }, (_, c) => XLSX.utils.encode_col(c)), totalRows: range.e.r + 1, totalColumns: range.e.c + 1, limited: limited || endRow <= range.e.r || endCol <= range.e.c || names.length > 100 };
}
if (parentPort) {
  try { parentPort.postMessage(previewWorkbook(Buffer.from(workerData.bytes), workerData.sheet)); }
  catch (error) { parentPort.postMessage({ error: `无法预览：${error.message}` }); }
}
