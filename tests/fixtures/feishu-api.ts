/** Official response shapes containing only invented messages; never reaches a network. */
export const feishuFixtureConfig = {
  realm: 'feishu',
  chatId: 'oc_synthetic_group',
  secretRef: 'secret:feishu/synthetic',
  startTime: '2026-09-30T00:00:00Z',
  endTime: 'now',
  overlapSeconds: '300',
};
export function feishuApiFixture() {
  let now = Date.parse('2026-09-30T12:00:00Z');
  let stage: 'initial' | 'updated' | 'deleted' | 'missing' | 'forbidden' =
    'initial';
  let failPages = 0;
  const requests: string[] = [];
  const token = 'synthetic-feishu-fixture-only';
  function message(
    id: string,
    text: string,
    extra: Record<string, unknown> = {},
  ) {
    return {
      message_id: id,
      chat_id: 'oc_synthetic_group',
      msg_type: 'text',
      create_time: String(Date.parse('2026-09-30T11:59:00Z')),
      update_time:
        stage === 'initial'
          ? String(Date.parse('2026-09-30T11:59:00Z'))
          : String(now),
      deleted: false,
      updated: stage !== 'initial',
      body: { content: JSON.stringify({ text }) },
      ...extra,
    };
  }
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    requests.push(url.href);
    if (
      url.origin !== 'https://open.feishu.cn' ||
      url.pathname !== '/open-apis/im/v1/messages'
    )
      throw new Error('FIXTURE_UNEXPECTED_ENDPOINT');
    if (new Headers(init?.headers).get('authorization') !== 'Bearer ' + token)
      throw new Error('FIXTURE_MISSING_AUTH');
    if (init?.redirect !== 'error') throw new Error('FIXTURE_UNSAFE_REDIRECT');
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (stage === 'forbidden')
      return Response.json(
        { code: 999, msg: 'synthetic permission denied' },
        { status: 403 },
      );
    const type = url.searchParams.get('container_id_type');
    const id = url.searchParams.get('container_id');
    const page = url.searchParams.get('page_token');
    const root = message(
      'om_synthetic_root',
      stage === 'updated'
        ? 'Topic: feishu-amber-updated\nConclusion: Recheck the current input.\nTodo: Keep revision evidence.\nRequirement: Explicit project scope.'
        : 'Topic: feishu-amber-plan\nConclusion: Keep retry work bounded.\nTodo: Verify cited source.\nRequirement: Search source and candidates.',
      {
        thread_id: 'omt_synthetic',
        ...(stage === 'deleted'
          ? { deleted: true, body: { content: '{}' } }
          : {}),
      },
    );
    const reply = message(
      'om_synthetic_reply',
      'Todo: synthetic-thread-reply-check',
      {
        thread_id: 'omt_synthetic',
        root_id: 'om_synthetic_root',
        parent_id: 'om_synthetic_root',
      },
    );
    if (type === 'thread') {
      if (
        id !== 'omt_synthetic' ||
        url.searchParams.has('start_time') ||
        url.searchParams.has('end_time')
      )
        throw new Error('FIXTURE_INVALID_THREAD_REQUEST');
      return Response.json({
        code: 0,
        data: {
          items: stage === 'missing' ? [reply] : [root, reply],
          has_more: false,
        },
      });
    }
    if (type !== 'chat' || id !== 'oc_synthetic_group')
      throw new Error('FIXTURE_CROSS_GROUP_REQUEST');
    if (failPages > 0 && page) {
      failPages--;
      throw new Error('Synthetic connection interruption');
    }
    if (page === 'empty')
      return Response.json({
        code: 0,
        data: { items: [], has_more: true, page_token: 'last' },
      });
    if (page === 'last')
      return Response.json({
        code: 0,
        data: {
          items: [
            message('om_synthetic_image', '', {
              msg_type: 'image',
              body: {
                content: '{"image_key":"synthetic-image-not-downloaded"}',
              },
            }),
          ],
          has_more: false,
        },
      });
    if (page) throw new Error('FIXTURE_UNKNOWN_PAGE');
    return Response.json({
      code: 0,
      data: {
        items: stage === 'missing' ? [] : [root],
        has_more: true,
        page_token: 'empty',
      },
    });
  };
  return {
    fetch: fetchMock,
    evidence: 'simulated' as const,
    now: () => now,
    requests,
    setStage(value: typeof stage) {
      stage = value;
      now += 60_000;
    },
    failNextPages(count: number) {
      failPages = count;
    },
    async resolveCredential(
      ref: string,
      scope: { realm: 'feishu' | 'lark'; chatId: string },
    ): Promise<string | undefined> {
      if (ref !== 'secret:feishu/synthetic') return undefined;
      if (scope.realm !== 'feishu' || scope.chatId !== 'oc_synthetic_group')
        throw new Error('SECRET_SCOPE_DENIED');
      return token;
    },
  };
}
