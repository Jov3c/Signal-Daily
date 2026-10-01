/**
 * 审核详情（后台 `/admin/review/[contentId]`）—— `docs/09` 的 Review Detail。
 *
 * `docs/09` 要求**同时看到**：
 *
 * ```text
 * 原文 / 翻译            左栏
 * 原始来源与原文链接       左栏（顶部）
 * Source kind/tier/official  左栏
 * AI 六维分数与理由        左栏
 * Event                 右栏
 * Primary Evidence       右栏（证据链编辑器里）
 * Supporting Evidence    右栏
 * 独立来源数量            右栏
 * 是否已有官方确认         右栏
 * 相似 / 重复内容         左栏底部
 * ```
 *
 * 「同时看到」是这条需求的全部要点 —— 所以是**两栏并排**，
 * 而不是一串折叠面板。少一次跳转，审核员就少一次分心。
 *
 * ⚠ 相似度**不显示数字**：`similarContents[].similarity` 后端恒为 `null`
 *（算法在 worker 侧，后台不重算）。所以这里只列「事件里还有哪些内容」，
 * 并如实说明没有相似度分数 —— 编一个百分比是最糟的选择，因为审核员
 * 会拿它做判断。
 */

import type { ReactElement } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AdminDenied, Badge, isoShort } from '../../../../components/admin-ui';
import { DecisionPanel, EvidenceEditor } from '../../../../components/admin-review-detail';
import { PageHead } from '../../../../components/shell';
import { loadAdminSingle } from '../../../../lib/admin-fetch';
import type { ReviewDetail } from '../../../../lib/admin-types';
import { IconExternal } from '../../../../components/icons';

/** 六维分数的中文名（`docs/08` 的六个维度）。 */
const DIMENSION_LABELS: [keyof ReviewDetail['aiScore']['dimensions'], string][] = [
  ['importance', '重要性'],
  ['relevance', '相关性'],
  ['credibility', '可信度'],
  ['novelty', '新颖度'],
  ['density', '信息密度'],
  ['readValue', '阅读价值'],
];

export default async function AdminReviewDetailPage({
  params,
}: {
  params: Promise<{ contentId: string }>;
}): Promise<ReactElement> {
  const { contentId } = await params;

  const result = await loadAdminSingle<ReviewDetail>(
    `/admin/review/${encodeURIComponent(contentId)}`,
    undefined,
    [401, 403, 404],
  );
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <AdminDenied status={result.status} />;
  }
  const detail = result.data;

  const { content, source, aiScore, event } = detail;
  const evidences = [
    ...(event?.primaryEvidence === null || event?.primaryEvidence === undefined
      ? []
      : [event.primaryEvidence]),
    ...(event?.supportingEvidence ?? []),
    ...(event?.relatedDiscussion ?? []),
  ];

  return (
    <div className="container">
      <PageHead
        eyebrow={`${source.name} · ${source.tier}${source.official ? ' · 官方' : ''}`}
        title={content.title}
        subtle={content.pipelineStatus}
        action={{ href: '/admin/review', label: '回队列' }}
      />

      <div className="review-layout">
        {/* ---------------- 左栏：内容与 AI 分数 ---------------- */}
        <div>
          <section className="detail-block">
            <h2>原始来源</h2>
            <dl className="kv">
              <dt>来源</dt>
              <dd>
                {source.name}{' '}
                <span className="subtle">
                  ({source.type} · {source.kind})
                </span>
              </dd>
              <dt>原文链接</dt>
              <dd>
                <a href={content.originalUrl} target="_blank" rel="noreferrer noopener">
                  {content.originalUrl} <IconExternal />
                </a>
              </dd>
              <dt>作者</dt>
              <dd>{content.language === '' ? '—' : content.language}（原文语言）</dd>
              <dt>发布</dt>
              <dd>
                {isoShort(content.publishedAt)} · 入库 {isoShort(content.createdAt)}
              </dd>
            </dl>
          </section>

          <section className="detail-block">
            <h2>AI 分数与理由</h2>
            {aiScore.finalScore === null ? (
              <p className="subtle">这条还没有评分（或者评分失败）。</p>
            ) : (
              <>
                <p>
                  <strong style={{ fontSize: '22px' }}>{aiScore.finalScore}</strong>{' '}
                  {aiScore.band === null ? null : <Badge tone="warn">{aiScore.band}</Badge>}
                </p>
                <dl className="kv">
                  {DIMENSION_LABELS.map(([key, label]) => (
                    <div key={key} style={{ display: 'contents' }}>
                      <dt>{label}</dt>
                      <dd>{aiScore.dimensions[key] ?? '—'}</dd>
                    </div>
                  ))}
                </dl>
                {aiScore.recommendationReason === null ? null : (
                  <p className="subtle" style={{ marginTop: '10px' }}>
                    推荐理由：{aiScore.recommendationReason}
                  </p>
                )}
                {aiScore.topics.length === 0 ? null : (
                  <p style={{ marginTop: '10px' }}>
                    {aiScore.topics.map((topic) => (
                      <span className="tag" key={topic}>
                        {topic}
                      </span>
                    ))}
                  </p>
                )}
              </>
            )}
          </section>

          <section className="detail-block">
            <h2>翻译</h2>
            {content.bodyTranslated === null ? (
              <p className="subtle">没有译文。</p>
            ) : (
              <p style={{ whiteSpace: 'pre-wrap' }}>{content.bodyTranslated.slice(0, 1200)}</p>
            )}
          </section>

          <section className="detail-block">
            <h2>原文</h2>
            {content.bodyOriginal === null ? (
              <p className="subtle">没有正文（可能是只有摘要的条目）。</p>
            ) : (
              /*
               * ⚠ 按 **HTML** 渲染，与前台 `ArticleBody` 一致 —— 编辑要判断的是
               * 「读者看到的这一版」是否可用，而不是看源码。用纯文本渲染时
               * 满屏是标签，判断不了排版，也看不出链接指向哪里。
               *
               * 安全上与前台同一条边界：`bodyOriginal` 是清洗过的 HTML
               * （唯一写入点 `normalize.ts → sanitizeArticleHtml`）。
               *
               * ⚠ `slice` 可能把标签**从中间截断**，于是这里渲染出的是不完整的
               * 标记。这是**有意的**：截断只为预览、减少后台页面的体积，被截断的
               * 部分由解析器丢弃。真正要读全文时到前台看。
               */
              <div
                className="article-text"
                style={{ whiteSpace: 'pre-wrap' }}
                dangerouslySetInnerHTML={{ __html: content.bodyOriginal.slice(0, 2000) }}
              />
            )}
          </section>

          <section className="detail-block">
            <h2>相似 / 重复内容</h2>
            {detail.similarContents.length === 0 ? (
              <p className="subtle">这个事件里没有其它内容。</p>
            ) : (
              <>
                <dl className="kv">
                  {detail.similarContents.map((item) => (
                    <div key={item.contentId} style={{ display: 'contents' }}>
                      <dt>{item.sourceName}</dt>
                      <dd>
                        <Link className="text-link" href={`/admin/review/${item.contentId}`}>
                          {item.title}
                        </Link>
                        {item.isEventPrimary ? ' · 事件主内容' : ''}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="subtle" style={{ marginTop: '8px' }}>
                  没有相似度百分比：算法在 worker 侧，后台不重算。
                  事件成员本身就是相似度判定的结论。
                </p>
              </>
            )}
          </section>
        </div>

        {/* ---------------- 右栏：事件、证据与动作 ---------------- */}
        <div>
          <DecisionPanel contentId={content.id} currentStatus={content.pipelineStatus} />

          <section className="detail-block">
            <h2>Event</h2>
            {event === null ? (
              <p className="subtle">这条内容还没有归入任何事件。</p>
            ) : (
              <dl className="kv">
                <dt>事件</dt>
                <dd>{event.canonicalTitle}</dd>
                <dt>独立来源数</dt>
                <dd>
                  <strong>{event.independentSourceCount}</strong>
                  <span className="subtle">（按不同 source_id 计）</span>
                </dd>
                <dt>官方确认</dt>
                <dd>
                  {event.hasOfficialConfirmation ? (
                    <Badge tone="warn">有</Badge>
                  ) : (
                    <span className="subtle">暂无</span>
                  )}
                </dd>
                <dt>本条地位</dt>
                <dd>{event.isPrimaryContent ? '事件主内容' : '事件成员'}</dd>
              </dl>
            )}
          </section>

          {event === null ? (
            <section className="detail-block">
              <h2>证据链</h2>
              <p className="subtle">
                证据挂在**事件**上，而这条内容还没有事件 —— 所以现在没有证据可维护。
                先把内容归入事件（管线自动做），或者人工建一个事件（V1 没有这个入口）。
              </p>
            </section>
          ) : (
            <EvidenceEditor eventId={event.id} evidences={evidences} />
          )}
        </div>
      </div>
    </div>
  );
}
