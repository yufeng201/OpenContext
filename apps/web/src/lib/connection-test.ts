import type { ConnectionTestResult } from '@opencontext/contracts';

const explanations: Record<string, string> = {
  SECRET_NOT_CONFIGURED:
    '未配置凭据。请管理员在服务器为该来源的 secretRef 注入凭据；不要在表单中粘贴 token。',
  SECRET_SCOPE_DENIED:
    '凭据引用未授权指定群或区域。请管理员核对 secretRef 的授权范围。',
  FEISHU_ACCESS_DENIED:
    '指定群历史接口拒绝访问。请核对应用权限及机器人在指定群内的访问条件。',
  FEISHU_AUTH_EXPIRED: '凭据无效或已过期。请管理员更新服务器凭据后重新测试。',
  FEISHU_RATE_LIMITED: '接口正在限流，请稍后重新测试，不要连续重试。',
  FEISHU_NETWORK_ERROR: '服务器暂时无法连接来源接口，请检查网络后重试。',
  SECRET_UNAVAILABLE:
    '服务器无法读取此凭据引用。请管理员核对 secretRef 的配置、指定群和区域授权。',
  SECRET_INVALID:
    '服务器凭据格式无效。请管理员更新 secretRef 对应凭据后重新测试。',
  AUTH_FAILED: '凭据无效或已过期。请管理员更新服务器凭据后重新测试。',
  PERMISSION_DENIED:
    '指定群历史接口拒绝访问。请核对应用权限及机器人在指定群内的访问条件。',
  NETWORK_ERROR: '服务器暂时无法连接来源接口，请检查网络后重试。',
  RATE_LIMITED: '接口正在限流，请稍后重新测试，不要连续重试。',
  UPSTREAM_UNAVAILABLE: '来源服务暂时不可用，请稍后重新测试。',
  INVALID_RESPONSE: '来源响应格式未通过校验，请管理员检查插件兼容性。',
  FEISHU_API_ERROR: '飞书接口返回错误，请管理员检查来源配置和权限后重试。',
};

export function connectionCodeExplanation(code: string) {
  return explanations[code];
}

export function connectionResultText(result: ConnectionTestResult) {
  return {
    evidence:
      result.evidence === 'simulated'
        ? '模拟接口验证，未连接真实飞书'
        : result.status === 'reachable'
          ? '指定群历史接口可读'
          : '真实接口诊断未通过',
    status: {
      reachable: '本次检查可读',
      blocked: '本次检查受阻',
      error: '本次检查失败',
    }[result.status],
    explanation:
      connectionCodeExplanation(result.code) ??
      (result.status === 'reachable'
        ? '仅验证指定群历史接口；不代表完整历史、附件、实时事件或全部权限可用。'
        : '请管理员根据诊断代码核对来源配置后重新测试。'),
  };
}
