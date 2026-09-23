import { check } from './workspace.mjs';
export function validateElicitation(schema, content) {
  check(schema?.type === 'object' && content && typeof content === 'object' && !Array.isArray(content), '插件表单格式无效。');
  const fields = schema.properties || {}; check(Object.keys(fields).length <= 50, '插件表单过大。');
  check(Object.keys(content).every(key => Object.hasOwn(fields, key)), '存在未声明的表单字段。');
  for (const [name, spec] of Object.entries(fields)) {
    const value = content[name];
    if (value == null) { check(!schema.required?.includes(name), `请填写 ${name}。`); continue; }
    check(['string', 'boolean', 'integer', 'number', 'array'].includes(spec.type), `网页暂不支持此表单字段：${name}（${spec.type}），请在官方客户端完成。`);
    if (spec.type === 'array') {
      const options = spec.items?.enum || spec.items?.anyOf?.map(option => option.const) || spec.items?.oneOf?.map(option => option.const);
      check(Array.isArray(options) && options.every(option => typeof option === 'string'), `${name} 不是支持的多选表单。`);
      check(Array.isArray(value) && value.length >= (spec.minItems || 0) && value.length <= Math.min(spec.maxItems ?? 100, 100) && new Set(value).size === value.length && value.every(item => options.includes(item)), `${name} 多选值无效。`);
    } else if (spec.type === 'string') {
      check(typeof value === 'string' && value.length >= (spec.minLength || 0) && value.length <= Math.min(spec.maxLength ?? 10000, 10000), `${name} 长度不正确。`);
      if (spec.format === 'email') check(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), `${name} 邮箱格式不正确。`);
      if (spec.format === 'uri') { let valid = false; try { valid = !!new URL(value).protocol; } catch {} check(valid, `${name} URL 格式不正确。`); }
      if (spec.format === 'date') check(/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, `${name} 日期无效。`);
      if (spec.format === 'date-time') check(/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)), `${name} 时间格式无效。`);
    } else if (spec.type === 'boolean') check(typeof value === 'boolean', `${name} 需要布尔值。`);
    else check(typeof value === 'number' && Number.isFinite(value) && (spec.type !== 'integer' || Number.isInteger(value)) && value >= (spec.minimum ?? -Infinity) && value <= (spec.maximum ?? Infinity), `${name} 数值不正确。`);
    if (spec.enum) check(spec.enum.includes(value), `${name} 不在允许选项内。`);
    if (spec.oneOf) check(spec.oneOf.some(option => option.const === value), `${name} 不在允许选项内。`);
  }
}
