/**
 * 主题详情（`/topics/[slug]`）。
 *
 * 原型的 `topics.html` 只有列表页（`PROJECT-MAP.md` 里没有主题详情），
 * 但搜索结果的目录里有一条指向 `topics.html` 的主题条目 —— 也就是说
 * 原型里本来就缺这一页。而 API 有 `GET /topics/:slug`
 *（`PublicTopic` + `contentCount` + `contents`），所以补上。
 *
 * 版式沿用人物详情的形状（`.person-hero` → 这里用 `.container` +
 * 区块标题），不新造视觉。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StoryRow } from '../../../../components/cards';
import { EmptyState, PageHead } from '../../../../components/shell';
import { ApiRequestError, serverFetch, type Single } from '../../../../lib/api';
import { shortRelative } from '../../../../lib/format';
import type { PublicContent, PublicTopic } from '@signal/contracts';

type TopicDetail = PublicTopic & { contentCount: number; contents: PublicContent[] };

export default async function TopicPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<ReactElement> {
  const { slug } = await params;

  let topic: TopicDetail;
  try {
    topic = (await serverFetch<Single<TopicDetail>>(`/topics/${encodeURIComponent(slug)}`)).data;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }

  const now = new Date();

  return (
    <div className="container">
      <PageHead
        eyebrow="Topic"
        title={topic.name}
        subtle={`共 ${String(topic.contentCount)} 条内容。`}
        action={{ href: '/topics', label: '全部主题' }}
      />

      {topic.contents.length === 0 ? (
        <EmptyState title="这个主题下还没有内容" hint="换一个主题看看。" />
      ) : (
        <section className="story-list">
          {topic.contents.map((content) => (
            <StoryRow
              key={content.id}
              content={content}
              relativeLabel={shortRelative(new Date(content.publishedAt ?? now), now)}
            />
          ))}
        </section>
      )}

      <p className="subtle" style={{ marginTop: '20px' }}>
        主题是内容导航，不是订阅对象 —— 这里没有关注按钮，将来也不会有。
        想按关键词找，去 <Link className="text-link" href="/search">搜索</Link>。
      </p>
    </div>
  );
}
