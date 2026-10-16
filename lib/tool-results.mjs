const imageLimit = 16;
const imageMime = /^image\/(png|jpeg|gif|webp)$/i;
const browserNames = { chrome: 'Chrome', edge: 'Edge', opera: 'Opera', brave: 'Brave', vivaldi: 'Vivaldi', safari: 'Safari', iab: '内置浏览器' };
const appNames = { 'com.google.Chrome': 'Chrome', 'com.microsoft.edgemac': 'Edge', 'com.operasoftware.Opera': 'Opera', 'com.apple.Safari': 'Safari' };

function surfaceOf(item) {
  if (!['cua_repl', 'computer-use'].includes(item.server)) return;
  const surface = item.result?._meta?.['codex/toolSurface'];
  if (surface?.kind === 'browserUse') {
    const family = typeof surface.browserFamily === 'string' ? surface.browserFamily.slice(0, 40) : '';
    return { kind: 'browser', label: browserNames[family] || (surface.backend === 'iab' ? '内置浏览器' : family || '浏览器') };
  }
  if (surface?.kind === 'computerUse' && surface.app?.kind === 'appId' && typeof surface.app.appId === 'string') {
    const appId = surface.app.appId.slice(0, 200);
    return { kind: 'app', label: appNames[appId] || appId };
  }
}

// Only inline images from actual tool results enter the authenticated registry.
// Text, resource URIs and arbitrary filesystem paths never become image reads.
export function toolResultContent(item, images) {
  const raw = item.result || item.contentItems;
  const content = Array.isArray(item.result?.content) ? item.result.content : Array.isArray(item.contentItems) ? item.contentItems : [];
  const attachments = [], encoded = new Set(); let totalImages = 0;
  const imageBlock = part => part?.type === 'image' || part?.type === 'inputImage'
    || part?.type === 'resource' && typeof part.resource?.mimeType === 'string' && part.resource.mimeType.startsWith('image/');
  for (const part of content) {
    if (!imageBlock(part)) continue;
    totalImages++;
    const resource = part.type === 'resource' ? part.resource : null;
    const data = resource ? resource.blob : part.data;
    const mime = resource ? resource.mimeType : part.mimeType;
    const url = part.type === 'inputImage' ? part.imageUrl : part.url;
    if (typeof data === 'string') encoded.add(data);
    if (typeof url === 'string') encoded.add(url);
    if (attachments.length >= imageLimit) continue;
    const name = `工具图片 ${totalImages}`;
    const source = typeof data === 'string' && imageMime.test(mime || '') && data.length <= 14_000_000
      ? `data:${mime};base64,${data}` : typeof url === 'string' && url.startsWith('data:image/') ? url : '';
    attachments.push(source && images ? images.describe({ type: 'image', url: source }, name) : { kind: 'image', name, unavailable: true });
  }
  const printable = item.error?.message || (raw ? JSON.stringify(raw, (key, value) => {
    if (key === '_meta') return undefined;
    if (imageBlock(value)) return { type: value.type, note: '图片数据已省略，可用图片显示在操作记录中' };
    if (value?.type === 'audio' || value?.type === 'inputAudio') return { type: value.type, note: '暂不支持音频预览' };
    if (typeof value === 'string' && (encoded.has(value) || /^data:image\/[^;]+;base64,/.test(value))) return '[图片内容已移至预览]';
    return value;
  }, 2) : '');
  const surface = surfaceOf(item);
  return {
    text: String(printable).slice(0, 100_000), outputTruncated: String(printable).length > 100_000,
    ...(attachments.length ? { attachments } : {}),
    ...(totalImages > imageLimit ? { omittedImages: totalImages - imageLimit } : {}),
    ...(surface ? { surface } : {}),
  };
}
