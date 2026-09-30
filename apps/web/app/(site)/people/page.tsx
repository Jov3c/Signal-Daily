/**
 * 人物（`/people`）—— 原型的 `people.html`。
 *
 * ⚠ **没有关注 / 订阅按钮**。`docs/23` 把「人物订阅」整个删掉了：
 * 人物页只负责**发现与浏览**，不建立任何用户关系。
 * `docs/17` 第 19 条对「前端没有我的订阅与 data-subscribe」有断言。
 *
 * 数据来自 `GET /people`（`PublicPerson` + `contentCount`）。
 */

import type { ReactElement } from 'react';
import { PersonCard } from '../../../components/cards';
import { EmptyState, PageHead } from '../../../components/shell';
import { serverFetch, type Single } from '../../../lib/api';
import type { PublicPerson } from '@signal/contracts';

type PersonWithCount = PublicPerson & { contentCount: number };

export default async function PeoplePage(): Promise<ReactElement> {
  const people = await serverFetch<Single<PersonWithCount[]>>('/people');

  return (
    <div className="container">
      <PageHead
        eyebrow="People"
        title="人物"
        subtle="Signal 编辑维护的 X 人物目录。这里是内容导航，不是关注列表。"
        action={{ href: '/x', label: '看 X 动态' }}
      />

      {people.data.length === 0 ? (
        <EmptyState title="还没有人物" hint="编辑还没有把 X 账号登记成人物。" />
      ) : (
        <section className="card-grid">
          {people.data.map((person) => (
            <PersonCard
              key={person.id}
              person={person}
              contentCount={person.contentCount}
            />
          ))}
        </section>
      )}
    </div>
  );
}
