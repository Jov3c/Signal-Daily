/**
 * @signal/contracts — Signal 全项目唯一公共契约入口。
 *
 * 由 Agent 00 拥有（《Signal 多 Agent 执行规则 v1.0》§6）。
 *
 * 使用规则：
 *   - web / api / worker 必须从这里 import 公共枚举与 DTO。
 *   - 严禁在 app 内复制 SourceType / ContentPipelineStatus 等公共类型。
 *   - 需要新枚举值或新字段时，提交 CONTRACT_CHANGE_REQUEST.md，不要就地改。
 */

export * from './enums';
export * from './api';
export * from './errors';
export * from './queues';
export * from './time';
export * from './dto/public';
