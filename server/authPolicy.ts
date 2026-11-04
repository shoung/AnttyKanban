export function bearerToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    !/^Bearer [A-Za-z0-9._~+/-]+={0,2}$/i.test(value)
  ) {
    throw Object.assign(new Error('Authentication required'), { status: 401 });
  }
  return value.slice(7);
}
export function enforceUid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 128 ||
    value.includes('/') ||
    [...value].some((char) => char.charCodeAt(0) < 32) ||
    value === '.' ||
    value === '..'
  ) {
    throw Object.assign(new Error('Invalid account identity'), { status: 401 });
  }
  return value;
}
