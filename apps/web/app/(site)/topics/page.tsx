/**
 * 主题（`/topics`）—— 原型的 `topics.html`。
 *
 * 与人物页同一形状：**只做发现与浏览**，没有订阅（`docs/23`）。
 * 数据来自 `GET /topics`（`PublicTopic` + `contentCount`）。
 */

import type { ReactElement } from 'react';
import { TopicCard } from '../../../components/cards';
import { EmptyState, PageHead } from '../../../components/shell';
import { serverFetch, type Single } from '../../../lib/api';
import type { PublicTopic } from '@signal/contracts';

type TopicWithCount = PublicTopic & { contentCount: number };

export default async function TopicsPage(): Promise<ReactElement> {
  const topics = await serverFetch<Single<TopicWithCount[]>>('/topics');

  return (
    <div className="container">
      <PageHead
        eyebrow="Topics"
        title="主题"
        subtle="按主题浏览内容。主题用于分类与导航 —— 不是订阅对象。"
        action={{ href: '/search', label: '搜索' }}
      />

      {topics.data.length === 0 ? (
        <EmptyState title="还没有主题" hint="内容被归类之后，主题会出现在这里。" />
      ) : (
        <section className="card-grid">
          {topics.data.map((topic) => (
            <TopicCard key={topic.id} topic={topic} contentCount={topic.contentCount} />
          ))}
        </section>
      )}
    </div>
  );
}
