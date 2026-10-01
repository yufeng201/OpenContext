/** Read only the explicitly configured Feishu credential, never the entire environment. */
export function feishuCredentials(env: Record<string, string | undefined>) {
  return async (
    ref: string,
    scope: { realm: 'feishu' | 'lark'; chatId: string },
  ): Promise<string | undefined> => {
    if (ref !== env['OPENCONTEXT_FEISHU_SECRET_REF']) return undefined;
    if (
      scope.realm !== env['OPENCONTEXT_FEISHU_REALM'] ||
      scope.chatId !== env['OPENCONTEXT_FEISHU_CHAT_ID']
    )
      throw new Error('SECRET_SCOPE_DENIED');
    const token = env['OPENCONTEXT_FEISHU_TOKEN'];
    if (!token) return undefined;
    if (token.length > 8192 || /\s/.test(token))
      throw new Error('INVALID_SERVER_CREDENTIAL');
    return token;
  };
}
