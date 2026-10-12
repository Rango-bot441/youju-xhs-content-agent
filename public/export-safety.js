// Shared browser/server policy. Source records remain unchanged; only delivery copies are sanitized.
const credentialPatterns = () => [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g,
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
];
const contactPatterns = () => [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?!\d)/g];
const credentialKey = key => /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|authorization)$/i.test(key);
const credentialValue = value => typeof value === 'string' && /^[A-Za-z0-9._~+/=-]{8,}$/.test(value);

export function redactSensitive(value) {
  let text = String(value ?? '');
  for (const pattern of credentialPatterns()) text = text.replace(pattern, '[凭据已隐藏]');
  const [email, phone] = contactPatterns();
  return text.replace(email, '[邮箱已隐藏]').replace(phone, '[手机已隐藏]');
}

export function inspectExportSafety(value) {
  let hasCredentials = false, hasContactDetails = false;
  const visit = item => {
    if (typeof item === 'string') {
      if (credentialPatterns().some(pattern => pattern.test(item))) hasCredentials = true;
      if (contactPatterns().some(pattern => pattern.test(item))) hasContactDetails = true;
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (credentialKey(key) && credentialValue(child)) hasCredentials = true;
      visit(key); visit(child);
    }
  };
  visit(value);
  return { blocked: hasCredentials, hasCredentials, hasContactDetails };
}

export function assertExportSafe(value) {
  if (inspectExportSafety(value).hasCredentials) {
    const error = new Error('检测到疑似访问凭据，已阻止交付。请在新版本中移除凭据后重新审核；人工忽略不能解除此限制。');
    error.status = 409;
    error.code = 'EXPORT_CREDENTIAL_BLOCKED';
    throw error;
  }
}

export function sanitizeExport(value) {
  assertExportSafe(value);
  const copy = item => typeof item === 'string' ? redactSensitive(item)
    : Array.isArray(item) ? item.map(copy)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, child]) => [redactSensitive(key), copy(child)])) : item;
  return copy(value);
}

export function safeExportFileName(title) {
  return sanitizeExport(String(title || '内容交付')).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60);
}
