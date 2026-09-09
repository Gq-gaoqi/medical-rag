/**
 * 统一日志工具：带时间戳与级别前缀，输出到控制台。
 * 便于在生产环境排查问题，后续可无缝替换为写入文件/远端日志。
 */

type Level = 'INFO' | 'WARN' | 'ERROR';

function emit(level: Level, scope: string, args: unknown[]) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level}] ${scope}`;
  // eslint-disable-next-line no-console
  const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  fn(prefix, ...args);
}

export const logger = {
  info: (scope: string, ...args: unknown[]) => emit('INFO', scope, args),
  warn: (scope: string, ...args: unknown[]) => emit('WARN', scope, args),
  error: (scope: string, ...args: unknown[]) => emit('ERROR', scope, args),
};
