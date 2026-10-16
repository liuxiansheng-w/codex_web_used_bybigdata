const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const ensure = (condition, message) => { if (!condition) fail(message); };
const unsupported = name => `网页暂不支持此表单字段：${name}，请在官方客户端完成。`;
export const mcpFormMode = mode => ['form', 'openai/form', 'openaiForm'].includes(mode);

// The extended schema may be carried in standard form metadata. Never submit
// the placeholder schema when the plugin supplied a richer interaction.
export function mcpFormSchema(params) {
  const extension = params?._meta?.['openai/elicitation'];
  return {
    schema: extension !== undefined ? extension?.requestedSchema : params?.requestedSchema,
    extended: params?.mode !== 'form' || extension !== undefined,
    confirmation: params?._meta?.['openai/confirmation'],
  };
}

function choices(spec, name) {
  if (spec.enum !== undefined) {
    ensure(Array.isArray(spec.enum), unsupported(name));
    return spec.enum.map((value, i) => ({ value, title: spec.enumNames?.[i] || value }));
  }
  const source = spec.oneOf ?? spec.anyOf;
  if (source === undefined) return null;
  ensure(Array.isArray(source), unsupported(name));
  return source.map(option => ({ value: option?.const, title: option?.title || option?.const, description: option?.description }));
}

function normalizeChoices(options, name) {
  if (!options) return null;
  ensure(options.length > 0 && options.length <= 200 && options.every(option => typeof option.value === 'string' && option.value.length <= 10000), unsupported(name));
  ensure(new Set(options.map(option => option.value)).size === options.length, unsupported(name));
  return options.map(option => ({ value: option.value, title: String(option.title || option.value).slice(0, 1000), description: typeof option.description === 'string' ? option.description.slice(0, 3000) : '' }));
}

function scalarError(spec, value, label) {
  if (spec.type === 'string') {
    if (typeof value !== 'string' || value.length < (spec.minLength || 0) || value.length > Math.min(spec.maxLength ?? 10000, 10000)) return `${label} 长度不正确。`;
    if (spec.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `${label} 邮箱格式不正确。`;
    if (spec.format === 'uri') { try { if (!new URL(value).protocol) return `${label} URL 格式不正确。`; } catch { return `${label} URL 格式不正确。`; } }
    if (spec.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return `${label} 日期无效。`;
    if (spec.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value)))) return `${label} 时间格式无效。`;
  } else if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') return `${label} 需要布尔值。`;
  } else if (typeof value !== 'number' || !Number.isFinite(value) || (spec.type === 'integer' && !Number.isInteger(value)) || value < (spec.minimum ?? -Infinity) || value > (spec.maximum ?? Infinity)) return `${label} 数值不正确。`;
  return null;
}

export function mcpFieldError(field, value) {
  const { spec, title, options } = field;
  if (value === undefined) return field.required ? `请填写 ${title}。` : null;
  if (spec.type === 'array') {
    if (!Array.isArray(value) || value.length < (spec.minItems || 0) || value.length > Math.min(spec.maxItems ?? 100, 100) || (spec.uniqueItems !== false && new Set(value).size !== value.length)) return `${title} 多选值无效。`;
    if (value.some(item => scalarError({ type: 'string', ...spec.items }, item, title) || options && !options.some(option => option.value === item))) return `${title} 多选值无效。`;
  } else {
    const error = scalarError(spec, value, title); if (error) return error;
    if (options && !options.some(option => option.value === value)) return `${title} 不在允许选项内。`;
  }
  return null;
}

export function describeMcpForm(schema, { extended = false, confirmation } = {}) {
  try {
    ensure(object(schema) && schema.type === 'object' && object(schema.properties ?? {}), '插件表单格式无效。');
    for (const constraint of ['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'patternProperties']) ensure(schema[constraint] === undefined, '网页暂不支持此插件表单的组合条件，请在官方客户端完成。');
    const entries = Object.entries(schema.properties || {});
    ensure(entries.length <= 50, '插件表单过大。');
    ensure(schema.required === undefined || Array.isArray(schema.required) && schema.required.every(key => typeof key === 'string' && Object.hasOwn(schema.properties || {}, key)), '插件表单必填字段无效。');
    if (confirmation !== undefined) {
      const presentation = confirmation?.presentation;
      ensure(confirmation?.version === 1 && typeof confirmation.field === 'string' && entries.length === 1 && schema.properties[confirmation.field]?.type === 'boolean' && schema.required?.includes(confirmation.field) && object(presentation) && typeof presentation.title === 'string', '网页暂不支持此插件的确认流程，请在官方客户端完成。');
      ensure(presentation.fields === undefined || Array.isArray(presentation.fields) && presentation.fields.length <= 20 && presentation.fields.every(field => typeof field?.label === 'string' && typeof field.value === 'string' && field.value.length <= 10000), '插件确认信息格式无效。');
    }
    const fields = entries.map(([key, spec]) => {
      ensure(object(spec) && ['string', 'boolean', 'number', 'integer', 'array'].includes(spec.type), unsupported(key));
      // Arbitrary patterns and conditional/nested schemas need a bounded schema
      // validator. Reject them explicitly rather than evaluating untrusted regex.
      for (const constraint of ['pattern', '$ref', 'allOf', 'not', 'if', 'then', 'else', 'const', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) ensure(spec[constraint] === undefined, unsupported(key));
      const source = spec.type === 'array' ? spec.items || {} : spec;
      ensure(object(source) && source.pattern === undefined && source.$ref === undefined, unsupported(key));
      for (const bound of ['minLength', 'maxLength', 'minItems', 'maxItems']) ensure(spec[bound] === undefined || Number.isInteger(spec[bound]) && spec[bound] >= 0, unsupported(key));
      for (const bound of ['minimum', 'maximum']) ensure(spec[bound] === undefined || typeof spec[bound] === 'number' && Number.isFinite(spec[bound]), unsupported(key));
      ensure(source.format === undefined || ['email', 'uri', 'date', 'date-time'].includes(source.format), unsupported(key));
      let options = choices(source, key), resource = false;
      if (spec['x-openai-input'] !== undefined) {
        const input = spec['x-openai-input'];
        ensure(extended && object(input) && ['resource', 'file'].includes(input.type) && Array.isArray(input.options) && input.userOptions === undefined && input.selection !== 'implicit' && ['string', 'array'].includes(spec.type) && source.format === 'uri', unsupported(key));
        options = input.options.map(option => ({ value: option?.uri, title: option?.title || option?.name || option?.uri, description: option?.description })); resource = true;
      }
      options = normalizeChoices(options, key);
      if (options) ensure(['string', 'array'].includes(spec.type), unsupported(key));
      if (spec.type === 'array') ensure(source.type === undefined && options || source.type === 'string' && (options || extended), unsupported(key));
      const suggestions = spec['x-openai-suggestions'] === undefined ? null : normalizeChoices(choices({ oneOf: spec['x-openai-suggestions'] }, key), key);
      const field = { key, spec, title: String(spec.title || key).slice(0, 1000), description: typeof spec.description === 'string' ? spec.description.slice(0, 5000) : '', required: schema.required?.includes(key) || false, options, resource, suggestions, extended };
      if (spec.default !== undefined) ensure(!mcpFieldError(field, spec.default), `${field.title} 的默认值无效。`);
      return field;
    });
    return { supported: true, fields, confirmation };
  } catch (error) { return { supported: false, fields: [], error: error.message }; }
}

export function validateMcpForm(schema, content, options) {
  const form = describeMcpForm(schema, options); ensure(form.supported, form.error);
  ensure(object(content), '插件表单格式无效。');
  const keys = new Set(form.fields.map(field => field.key));
  ensure(Object.keys(content).every(key => keys.has(key)), '存在未声明的表单字段。');
  for (const field of form.fields) {
    const error = mcpFieldError(field, Object.hasOwn(content, field.key) ? content[field.key] : undefined);
    ensure(!error, error);
  }
}
