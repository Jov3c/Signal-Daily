/**
 * X 动态（`/x`）—— 原型的 `x.html`。
 *
 * ```text
 * page-head   First-hand voices | X 动态 | 只收录少量优质 AI / 科技 X 账号…
 * tabs        全部 / …（见下）
 * feed-narrow 一条条 .x-post
 * ```
 *
 * ── ⚠ 标签页与原型不同，这是一个**被逼出来的**偏离，理由要写清楚 ────
 * 原型写死了五个标签：`全部 / AI / 研究 / 开发 / 产品`。而 API 的
 * `/x?category=` 过滤的是 **`person.category`**（一个人物属性，
 * `VarChar(120)` 自由文本），不是主题。于是：
 *
 * ```text
 * 1. `PublicPerson` **没有** category 字段      → 前端拿不到每人的分类
 * 2. 也没有任何接口能列出「有哪些分类」          → 5 个标签的取值无从得知
 * 3. 管理端也没有写 person.category 的地方       → 这个字段目前是空的
 * ```
 *
 * 也就是说：照抄那五个标签，点下去**必然 0 条**（取值对不上），
 * 那是一个看起来能点、实际永远为空的控件 —— 比换一组标签更糟。
 *
 * 所以这里改成用**唯一一个真的能服务端过滤的参数** `personId`：
 * 标签 = `全部` + `/people` 的前四位人物。视觉形状（`.tabs` 里的按钮）
 * 与原型一致，只是文案与语义换成了能工作的那个。
 *
 * 已记入 `CONTRACT_CHANGE_REQUEST-agent-13.md` 第 3 项：要让「按分类浏览
 * X 动态」成立，需要放开 `PublicPerson.category` 或加一个分类清单接口。
 *
 * ── ⚠ 没有关注 / 订阅 / 评论 / 私信 ─────────────────────────────────
 * 用户能做的只有：看原文、看翻译、收藏、跳去 X（`docs/23`）。
 * `docs/17` 第 19 条对「没有订阅 UI」有断言。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { EmptyState, PageHead } from '../../../components/shell';
import { XPost } from '../../../components/x-post';
import { serverFetch, type CursorPage, type Single } from '../../../lib/api';
import { shortRelative } from '../../../lib/format';
import type { PublicContent, PublicPerson } from '@signal/contracts';

/** 标签数量与原型一致（全部 + 4 个）。 */
const MAX_PERSON_TABS = 4;

type PersonWithCount = PublicPerson & { contentCount: number };

export default async function XPage({
  searchParams,
}: {
  searchParams: Promise<{ person?: string }>;
}): Promise<ReactElement> {
  const { person } = await searchParams;

  // ⚠ 这两步**必须串行**：`?person=<slug>` 要换成 id 才能给 API，
  // 而 id 只有拿到人物列表之后才知道。想并行就得让 `?person=` 直接收 id，
  // 那会把「好看且稳定的 slug」暴露成 URL 契约的一部分 ——
  // 而 slug 是编辑可以改的（改了所有旧链接就断）。
  const people = await serverFetch<Single<PersonWithCount[]>>('/people').catch(() => ({
    data: [] as PersonWithCount[],
  }));
  const feed = await serverFetch<CursorPage<PublicContent>>('/x', {
    query: { personId: personIdOf(people.data, person) },
  });

  const now = new Date();
  const tabs = people.data.slice(0, MAX_PERSON_TABS);

  return (
    <div className="container">
      <PageHead
        eyebrow="First-hand voices"
        title="X 动态"
        subtle="只收录少量优质 AI / 科技 X 账号，账号由 Signal 后台白名单维护，可随时新增或停用。"
        action={{ href: '/people', label: '查看人物库' }}
      />

      <div className="tabs">
        <Link className={person === undefined ? 'tab active' : 'tab'} href="/x">
          全部
        </Link>
        {tabs.map((item) => (
          <Link
            key={item.id}
            className={person === item.slug ? 'tab active' : 'tab'}
            href={`/x?person=${encodeURIComponent(item.slug)}`}
          >
            {item.name}
          </Link>
        ))}
      </div>

      <section className="feed-narrow">
        {feed.data.length === 0 ? (
          <EmptyState
            title="这里还没有内容"
            hint="X 白名单里的账号还没有产出，或者内容还在审核。"
          />
        ) : (
          feed.data.map((content) => (
            <XPost
              key={content.id}
              content={content}
              // 服务端算好的相对时间（水合安全，见 lib/format.ts）。
              relativeLabel={shortRelative(new Date(content.publishedAt ?? now), now)}
              // 设置里的 `defaultTranslation` 是**服务端偏好**，
              // 匿名访客按「不自动展开」处理（原型：X 页面默认仍优先展示原文）。
              defaultShowTranslation={false}
            />
          ))
        )}
      </section>
    </div>
  );
}

/** 把 `?person=<slug>` 换成 `personId`（API 认的是 id）。 */
function personIdOf(people: PersonWithCount[], slug: string | undefined): string | undefined {
  if (slug === undefined || slug === '') return undefined;
  return people.find((item) => item.slug === slug)?.id;
}
