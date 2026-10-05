/**
 * 兼容旧导入路径；模型/API 失败分类、重试预算与退避算法的唯一实现位于 runtime/failure-policy。
 */
export { FailurePolicy as SessionRetry } from "@/runtime/failure-policy"
