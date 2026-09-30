/**
 * 人物详情（`/people/[slug]`）—— 原型的 `person.html`。
 *
 * ```text
 * .person-hero   头像 / 名字 / @handle / bio
 * .mini-grid     他/她最近的内容
 * ```
 *
 * ⚠ **这里也没有订阅按钮**（`docs/23`）。原型里本来就没有 —— v1.7 的
 * 「删除」段点名删掉了人物订阅，所以这一页只有「看内容」和「去 X」。
 *
 * ⚠ bio 与分类**不在** `PublicPerson` 里（契约只给了 id / name / slug /
 * xHandle / avatarUrl）。后端 `people` 表有 `bio` 与 `category`，
 * 但公开接口没有暴露它们。所以这一页不显示简介 —— 不是忘了，
 * 是拿不到。已记入 `CONTRACT_CHANGE_REQUEST-agent-13.md` 第 3 项。
 */

import type { ReactElement } from 'react';
import { notFound } from 'next/navigation';
import { MiniCard } from '../../../../components/cards';
import { EmptyState, PageHead } from '../../../../components/shell';
import { ApiRequestError, serverFetch, type Single } from '../../../../lib/api';
import { initialsOf, shortRelative } from '../../../../lib/format';
import type { PublicContent, PublicPerson } from '@signal/contracts';

type PersonDetail = PublicPerson & { contentCount: number; contents: PublicContent[] };

export default async function PersonPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<ReactElement> {
  const { slug } = await params;

  let person: PersonDetail;
  try {
    person = (await serverFetch<Single<PersonDetail>>(`/people/${encodeURIComponent(slug)}`)).data;
  } catch (error) {
    // 不存在 → 404 页面。其它错误继续抛：一次后端故障不该变成
    // 「这个人不存在」，那会让人以为数据丢了。
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }

  const now = new Date();

  return (
    <div className="container">
      <section className="person-hero">
        <div className="avatar">{initialsOf(person.name)}</div>
        <div>
          <h1>{person.name}</h1>
          {person.xHandle === null || person.xHandle === undefined ? null : (
            <div className="subtle">@{person.xHandle}</div>
          )}
          <div className="meta">
            <span>{person.contentCount} 条内容</span>
          </div>
        </div>
      </section>

      <PageHead
        eyebrow="Recent"
        title="最近的内容"
        action={{ href: '/people', label: '全部人物' }}
      />

      {person.contents.length === 0 ? (
        <EmptyState title="这个人还没有内容" hint="可能是刚登记，或者内容还在审核。" />
      ) : (
        <section className="mini-grid">
          {person.contents.map((content) => (
            <MiniCard
              key={content.id}
              meta={`${content.source.name} · ${shortRelative(new Date(content.publishedAt ?? now), now)}`}
              title={content.title}
              href={`/article/${content.id}`}
            />
          ))}
        </section>
      )}
    </div>
  );
}
